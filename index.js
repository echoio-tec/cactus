const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

const nvidia = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
  timeout: 45000 
});

// Higienização e mesclagem de mensagens consecutivas
function sanitizarHistorico(historico) {
  const limpo = [];
  for (const msg of historico) {
    if (msg.role === 'system') continue;
    if (limpo.length === 0) {
      if (msg.role === 'user') limpo.push({ role: msg.role, content: msg.content });
    } else {
      const ultima = limpo[limpo.length - 1];
      if (ultima.role === msg.role) {
        ultima.content += `\n${msg.content}`; 
      } else {
        limpo.push({ role: msg.role, content: msg.content });
      }
    }
  }
  return limpo;
}

// BUSCA WEB VIA TAVILY
async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente.";
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        search_depth: "basic", 
        max_results: 3
      })
    });
    if (!response.ok) return "Sem resultados.";
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nConteúdo: ${r.content}`).join('\n\n') : "Sem dados.";
  } catch (err) {
    return "Falha na busca web.";
  }
}

app.post('/api/perguntar', async (req, res) => {
  const { historico, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  
  const historicoSanitizado = sanitizarHistorico(historico);
  const ultimaMensagem = historicoSanitizado.length > 0 ? historicoSanitizado[historicoSanitizado.length - 1].content : '';
  let dadosInternet = "Pesquisa inativa.";
  let decolagemVisaoTexto = "";

  try {
    // ESTÁGIO 1: EXTRAÇÃO MULTIMODAL ULTRA-RÁPIDA (OS OLHOS)
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Vision] Mapeando dados estruturados da imagem...");
      try {
        const ocrMapeamento = await nvidia.chat.completions.create({
          model: "meta/llama-3.2-11b-vision-instruct",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Transcreva de forma exaustiva e rigorosa todas as palavras, títulos, colunas, números, escalas e dados presentes nesta imagem. Forneça uma descrição puramente factual e estruturada do conteúdo visual para processamento analítico posterior." },
                { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
              ]
            }
          ]
        });
        decolagemVisaoTexto = ocrMapeamento.choices?.[0]?.message?.content || "";
        console.log("[Cactus-Vision] Sucesso na extração visual.");
      } catch (errVision) {
        console.error("Falha no canal de visão:", errVision);
        decolagemVisaoTexto = "Erro técnico ao processar metadados da imagem.";
      }
    }

    // CONFIGURAÇÃO DA DIRETRIZ MASTER DO CACTUS
    let sistemaTexto = "Seu nome é Cactus. Você é um analista de inteligência artificial de elite, de nível sênior, altamente focado, profissional e profundo. Suas respostas devem possuir forte maturidade acadêmica, excelente contextualização técnica e rigor intelectual. Evite resumos superficiais, obviedades ou respostas puramente literais.";

    if (memoryContext) sistemaTexto += `\n\n[CONHECIMENTO ESTABELECIDO SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[DIRETRIZES DE FORMATAÇÃO EXIGIDAS]:\n${customInstructions}`;
    
    // Injeção cruzada: Os cérebros textuais agora ganham acesso total ao que estava na imagem!
    if (decolagemVisaoTexto) {
      sistemaTexto += `\n\n[DADOS REAIS EXTRAÍDOS DA IMAGEM ENVIADA]:\n${decolagemVisaoTexto}\n\nNota: Use as informações acima para construir uma explicação contextualizada, profunda, técnica e científica sobre o assunto abordado na imagem.`;
    }
    if (arquivoAnexo && arquivoAnexo.tipo === 'texto') {
      sistemaTexto += `\n\n[CONTEÚDO DO ARQUIVO ANEXADO]:\n${arquivoAnexo.conteudo}`;
    }
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[PESQUISA WEB EM TEMPO REAL]:\n${dadosInternet}`;
    }

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];

    // ESTÁGIO 2: O RINGUE DOS CÉREBROS (DeepSeek + Gemma 2 + Llama 3.1 processando os dados extraídos)
    console.log("[Cactus-Engine] Disparando batalha tripla de alta performance.");
    const [chamadaDeepSeek, llamadaGemma, chamadaLlama8b] = await Promise.all([
      nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "google/gemma-2-27b-it", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message })),
      nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(err => ({ error: true, message: err.message }))
    ]);

    const res1 = chamadaDeepSeek.error ? chamadaDeepSeek.message : (chamadaDeepSeek.choices?.[0]?.message?.content || "Vazio.");
    const res2 = llamadaGemma.error ? llamadaGemma.message : (llamadaGemma.choices?.[0]?.message?.content || "Vazio.");
    const res3 = chamadaLlama8b.error ? chamadaLlama8b.message : (chamadaLlama8b.choices?.[0]?.message?.content || "Vazio.");

    // ESTÁGIO 3: O VEREDITO ACADÊMICO (Llama 70B exige nível profissional superior)
    const promptJuiz = `
Você é o Avaliador-Chefe do ecossistema Cactus. Analise as três opções de resposta geradas pelo nosso painel de agentes e selecione a que possui o maior nível de profundidade, qualidade técnica, excelência acadêmica e profissionalismo.
Rejeite terminantemente respostas preguiçosas, rasas, puramente descritivas ou que apenas repitam o texto em tópicos simples. Escolha a resposta que realmente ensina e contextualiza o assunto com maturidade científica e responda obrigatoriamente em português.
Retorne APENAS o texto completo e exato da resposta vencedora, sem comentários ou justificativas.

Comando do Usuário: "${ultimaMensagem}"

Opção 1: ${res1}
Opção 2: ${res2}
Opção 3: ${res3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.1-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaVencedora = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : res1;

    res.json({
      respostaFinal: respostaVencedora,
      auditoria: { deepseek: res1, gemma: res2, llama8b: res3, webRaw: arquivoAnexo ? `Fusão Multimodal Ativa: ${arquivoAnexo.nome}` : "Nenhum anexo." }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Engine] Ativo com pipeline de fusão na porta ${PORT}`));
