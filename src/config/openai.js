const { OpenAI } = require('openai');

const nvidia = new OpenAI({ 
  apiKey: process.env.NVIDIA_API_KEY, 
  baseURL: 'https://integrate.api.nvidia.com/v1', 
  timeout: 45000 
});

module.exports = nvidia;