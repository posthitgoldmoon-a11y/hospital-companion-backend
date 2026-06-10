const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function processCustomerInput(userMessage) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  
  const prompt = `You are a hospital companion service chatbot.
Analyze the customer message and classify it into one of:
1. Hospital companion reservation (with driver)
2. Hospital companion reservation (without driver)
3. Service inquiry

Customer message: "${userMessage}"

Response: JSON format { "category": "1|2|3", "message": "what you understood", "extracted_info": {} }
  `;
  
  const result = await model.generateContent(prompt);
  return result.response.text();
}

module.exports = { processCustomerInput };
