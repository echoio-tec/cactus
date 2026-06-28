const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

// Configurações básicas do servidor
app.use(cors());
app.use(express.json());

// Entrega os arquivos da pasta 'public' (seu HTML/Interface) automaticamente
app.use(express.static('public'));

// Configuração do cliente NVIDIA usando a estrutura da OpenAI
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY, // Chave configurada de forma segura no Render
  baseURL: 'https://integrate.api.nvidia.com/v1'
});

// Rota principal que o seu site vai chamar ao enviar uma pergunta
app.post('/api/perguntar', async (req, res) => {
  const { pergunta } = req.body;

  // Validação para garantir que a pergunta chegou corretamente
  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`Nova pergunta recebida: "${pergunta}"`);

    // 1. Disparando chamadas em paralelo para os modelos da NVIDIA
    const [chamadaDeepSeek, llamadaGemma] = await Promise.all([
      nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message })),

      nvidia.chat.completions.create({
        model: "google/diffusiongemma-26b-a4b-it",
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message }))
    ]);

    const respostaDeepSeek = chamadaDeepSeek.error ? "Erro ao carregar DeepSeek" : chamadaDeepSeek.choices[0].message.content;
    const respostaGemma = llamadaGemma.error ? "Erro ao carregar Gemma" : llamadaGemma.choices[0].message.content;

    // 2. Construindo o prompt para a IA Juíza avaliar as respostas
    const promptJuiz = `
Você é um avaliador rigoroso e especialista em respostas de Inteligência Artificial.
Analise a pergunta original do usuário e escolha qual das duas opções fornecidas é a melhor (mais precisa, clara e completa).
Sua resposta deve conter APENAS E EXATAMENTE o texto da melhor opção escolhida. Não adicione saudações, explicações ou justificativas.

Pergunta do Usuário: "${pergunta}"

Opção 1:
${respostaDeepSeek}

Opção 2:
${respostaGemma}
    `;

    // 3. O modelo Juiz decide a vencedora
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "deepseek-ai/deepseek-v4-pro",
      messages: [{ role: "user", content: promptJuiz }]
    });

    const respostaVencedora = chamadaJuiz.choices[0].message.content;

    // 4. Devolvemos a melhor resposta para o Frontend junto com a auditoria dos bastidores
    res.json({
      respostaFinal: respostaVencedora,
      auditoria: {
        deepseek: respostaDeepSeek,
        gemma: respostaGemma
      }
    });

  } catch (error) {
    console.error('Erro geral no processamento:', error);
    res.status(500).json({ error: 'Erro interno ao consultar os modelos de IA.' });
  }
});

// Define a porta do servidor (o Render configura a porta automaticamente)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
