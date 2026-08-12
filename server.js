const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenAI, Type } = require('@google/genai');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Config — edit directly here, no admin panel, no live editing ──
const clientConfig = {
  companyName: 'Luminary Realty',
  industry: 'Real Estate',
  agentName: 'Ava',
  primaryColor: '#1F3B57',
  welcomeMessage: "Hi! I'm Ava, your AI real estate assistant. Looking to buy, sell, or rent? 🏡",
  faqs: [
    { question: 'What properties do you currently have available?', answer: "We have a range of properties including apartments, houses, land and commercial spaces. Tell me your preferred location, property type and budget and I can help narrow down the options." },
    { question: 'How much does the property cost?', answer: "Prices vary by property. If you tell me which property you're interested in, I can provide its current asking price." },
    { question: 'Where is the property located?', answer: "Our properties are available across different locations. Tell me your preferred area and I'll help you find suitable options." },
    { question: 'Can I schedule a viewing?', answer: "Absolutely. I can help you schedule a viewing. Just tell me which property you're interested in and your preferred date and time." },
    { question: 'Do you accept installment payments?', answer: 'Payment options depend on the specific property. I can connect you with an agent who can provide the exact payment terms.' },
    { question: 'Is this property still available?', answer: "I can help check availability. Please send me the property you're interested in." },
    { question: 'Can I speak with an agent?', answer: 'Of course. I can collect your details and connect you with an agent.' },
    { question: "I'm not sure what property I need. Can you help?", answer: "Absolutely. Tell me your preferred location, budget, number of bedrooms and whether you're buying or renting, and I'll help you narrow down your options." },
    { question: 'Do you offer rentals?', answer: 'Yes, depending on the properties currently available.' },
    { question: 'Do you sell land?', answer: 'If land is part of our current inventory, I can help you find available options based on your preferred location and budget.' },
  ],
  // Sample inventory for the demo — swap for real listings per client
  properties: [
    { id: 'p1', type: 'apartment', location: 'Maitama', bedrooms: 2, price: 45000000, status: 'available', forRent: false },
    { id: 'p2', type: 'apartment', location: 'Wuse 2', bedrooms: 3, price: 850000, status: 'available', forRent: true },
    { id: 'p3', type: 'house', location: 'Gwarinpa', bedrooms: 4, price: 120000000, status: 'available', forRent: false },
    { id: 'p4', type: 'land', location: 'Guzape', bedrooms: null, price: 60000000, status: 'available', forRent: false },
    { id: 'p5', type: 'commercial', location: 'Central Business District', bedrooms: null, price: 250000000, status: 'available', forRent: false },
  ],
};

// In-memory demo storage — resets on restart, fine for a demo
let leads = [];
let bookings = [];

// ── Tool definitions the model can call ──
const tools = [{
  functionDeclarations: [
    {
      name: 'search_properties',
      description: 'Search available property inventory by location, type, budget, or bedrooms. Use this whenever a lead asks what is available or you are ready to recommend options.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          location: { type: Type.STRING, description: 'Preferred location or area, if known' },
          type: { type: Type.STRING, description: 'apartment, house, land, or commercial' },
          maxPrice: { type: Type.NUMBER, description: 'Maximum budget in local currency' },
          bedrooms: { type: Type.NUMBER, description: 'Minimum number of bedrooms, if relevant' },
          forRent: { type: Type.BOOLEAN, description: 'true if renting, false if buying' },
        },
      },
    },
    {
      name: 'capture_lead',
      description: "Save a lead's contact info and interest once you have their name and at least a phone or email. Call this as soon as you have enough info — do not wait until the end of the conversation.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          phone: { type: Type.STRING },
          email: { type: Type.STRING },
          interest: { type: Type.STRING, description: 'What they are looking for, e.g. "3-bed apartment in Wuse 2, buying, budget 100M"' },
          intent: { type: Type.STRING, description: 'buying, renting, or selling' },
        },
        required: ['name'],
      },
    },
    {
      name: 'book_viewing',
      description: 'Book a property viewing once the lead has picked a property and given a preferred date/time. Also hands off to a human agent.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          phone: { type: Type.STRING },
          propertyId: { type: Type.STRING, description: 'The property id from search_properties results, if known' },
          propertyDescription: { type: Type.STRING, description: 'Fallback description if no id available' },
          preferredDate: { type: Type.STRING },
          preferredTime: { type: Type.STRING },
        },
        required: ['name', 'phone'],
      },
    },
  ],
}];

function searchProperties({ location, type, maxPrice, bedrooms, forRent }) {
  return clientConfig.properties.filter(p => {
    if (p.status !== 'available') return false;
    if (location && !p.location.toLowerCase().includes(location.toLowerCase())) return false;
    if (type && p.type.toLowerCase() !== type.toLowerCase()) return false;
    if (maxPrice && p.price > maxPrice) return false;
    if (bedrooms && (p.bedrooms ?? 0) < bedrooms) return false;
    if (typeof forRent === 'boolean' && p.forRent !== forRent) return false;
    return true;
  });
}

function captureLead(args) {
  const lead = { id: `lead_${Date.now()}`, ...args, capturedAt: new Date().toISOString() };
  leads.push(lead);
  console.log('🟢 New lead captured:', lead);
  return { success: true, leadId: lead.id };
}

function bookViewing(args) {
  const booking = { id: `booking_${Date.now()}`, ...args, bookedAt: new Date().toISOString(), handoffToHuman: true };
  bookings.push(booking);
  console.log('📅 Viewing booked, human handoff triggered:', booking);
  return { success: true, bookingId: booking.id, message: 'Viewing request logged. A human agent will confirm shortly.' };
}

function runTool(name, args) {
  if (name === 'search_properties') return searchProperties(args);
  if (name === 'capture_lead') return captureLead(args);
  if (name === 'book_viewing') return bookViewing(args);
  return { error: 'Unknown tool' };
}

// ── System prompt: the funnel logic ──
function buildSystemPrompt(config) {
  const faqText = config.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n');

  return `
You are ${config.agentName}, the AI employee for ${config.companyName}, a ${config.industry} company.

You don't just answer questions — you actively move conversations toward a booked viewing or a captured lead. Follow this flow naturally, without sounding like a script:

1. ANSWER — Handle FAQs briefly and warmly (see below).
2. QUALIFY — Once someone shows real interest, ask for what you're missing: location, property type, budget, bedrooms, buying vs. renting. Ask one or two questions at a time, not a checklist.
3. RECOMMEND — As soon as you have enough info, call search_properties and recommend 1-3 real matches by location/type/price. If nothing matches, say so honestly and offer to connect them with an agent.
4. CAPTURE — Once you have their name and a phone or email, call capture_lead immediately. Don't wait — do this as soon as you reasonably can, even mid-conversation.
5. BOOK — If they want a viewing, get their preferred date/time and call book_viewing.
6. HANDOFF — After booking, confirm a human agent will follow up to finalize — this is not a promise you personally can fulfill.

RULES:
- Never invent property details, prices, or availability — only use what search_properties returns.
- Never give legal, financial, or contract advice — hand that to a human agent.
- Keep replies short (1-3 sentences), warm, and human — like a sharp assistant, not a script.
- Don't ask for info you already have.

FREQUENTLY ASKED QUESTIONS:
${faqText}

TONE: Confident, warm, professional — like a great local agent's assistant.
`;
}

// ── Chat endpoint with tool-calling loop ──
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'Message is required' });

  try {
    const geminiHistory = history.map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));

    const chat = ai.chats.create({
      model: 'gemini-2.5-flash',
      config: { systemInstruction: buildSystemPrompt(clientConfig), tools },
      history: geminiHistory,
    });

    let response = await chat.sendMessage({ message });

    let guard = 0;
    while (response.functionCalls?.length && guard < 5) {
      const call = response.functionCalls[0];
      const result = runTool(call.name, call.args);

      response = await chat.sendMessage({
        message: [{ functionResponse: { name: call.name, response: result } }],
      });
      guard++;
    }

    res.json({ reply: response.text });
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.status(500).json({ error: 'AI service error. Please try again.' });
  }
});

// ── Read-only config for the widget (no write route — no admin) ──
app.get('/api/config', (req, res) => {
  const { companyName, agentName, primaryColor, welcomeMessage } = clientConfig;
  res.json({ companyName, agentName, primaryColor, welcomeMessage });
});

// Vercel imports this as a serverless function — no .listen() needed there.
// Locally (node server.js), this still runs a normal server.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
}

module.exports = app;