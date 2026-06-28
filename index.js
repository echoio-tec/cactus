const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

// Permite que o seu Frontend acesse o Backend mesmo estando em links diferentes
app.use(cors());
app.use(express.json());

// Configuração do cliente NVIDIA usando a estrutura da OpenAI
const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY, // Essa chave configuraremos direto no Render depois
  baseURL: 'https://integrate.api.nvidia.com/v1'
});

// Rota simples de teste para garantir que o servidor está vivo
app.get('/', (req, res) => {
  res.send('Servidor do TecAI está online e rodando com sucesso!');
});

// Rota principal que o seu site vai chamar ao enviar uma pergunta
app.post('/api/perguntar', async (req, res) => {
  const { pergunta } = req.body;

  if (!pergunta) {
    return res.status(400).json({ error: 'Por favor, forneça uma pergunta.' });
  }

  try {
    console.log(`Nova pergunta recebida: "${pergunta}"`);

    // 1. Disparando chamadas em paralelo para os modelos da NVIDIA
    // Usamos um bloco .catch em cada uma para que se uma IA falhar, o site não caia
    const [chamadaDeepSeek, chamadaGemma] = await Promise.all([
      nvidia.chat.completions.create({
        model: "deepseek-ai/deepseek-v4-flash", // Modelo rápido da DeepSeek do seu catálogo
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message })),

      nvidia.chat.completions.create({
        model: "google/diffusiongemma-26b-a4b-it", // Modelo da Google que vimos na sua tela
        messages: [{ role: "user", content: pergunta }]
      }).catch(err => ({ error: true, message: err.message }))
    ]);

    // Extraindo o texto gerado por cada modelo (ou pegando a mensagem de erro se falhou)
    const respostaDeepSeek = chamadaDeepSeek.error ? "Erro ao carregar DeepSeek" : chamadaDeepSeek.choices[0].message.content;
    const respostaGemma = chamadaGemma.error ? "Erro ao carregar Gemma" : chamadaGemma.choices[0].message.content;

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

    // 3. O modelo Juiz (um modelo mais robusto e inteligente) decide a vencedora
    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "deepseek-ai/deepseek-v4-pro", // Usando a versão Pro para melhor raciocínio crítico
      messages: [{ role: "user", content: promptJuiz }]
    });

    const respostaVencedora = chamadaJuiz.choices[0].message.content;

    // 4. Devolvemos a melhor resposta para o Frontend, além de um histórico das outras se quiser mostrar
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

// Define a porta do servidor (o Render define isso automaticamente)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
});
