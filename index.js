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
  timeout: 60000
});

// Tratamento defensivo local para promises paralelas
function tratarErroPromessa(modelo) {
  return (err) => ({ error: true, message: `Erro no modelo ${modelo}: ${err.message}` });
}

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

async function buscarNaWeb(query) {
  try {
    if (!process.env.TAVILY_API_KEY) return "Aviso: Chave da Tavily ausente.";
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query: query, search_depth: "basic", max_results: 3 })
    });
    if (!response.ok) return "Sem resultados.";
    const data = await response.json();
    return data.results ? data.results.map(r => `Título: ${r.title}\nContents: ${r.content}`).join('\n\n') : "Sem dados.";
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

  try {
    // 🎨 INTEGRALIZAÇÃO DO GERADOR DE IMAGEM
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) return res.json({ respostaFinal: "Por favor, especifique o que deseja gerar. Exemplo: \`/gerar um cacto neon\`" });

      console.log(`[Cactus-ImageEngine] Gerando arte para prompt: "${promptImagem}"`);
      
      try {
        const responseImg = await nvidia.images.generate({
          model: "stabilityai/stable-diffusion-xl",
          prompt: promptImagem
        });
        
        return res.json({
          respostaFinal: `🎨 Aqui está a imagem gerada para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
          auditoria: { deepseek: "Imagem renderizada com sucesso via SDXL", gemma: "N/A", llama8b: "N/A", webRaw: "Geração Gráfica Ativa" }
        });
      } catch (errImg) {
        console.error("[Cactus-ImageEngine] Falha de comunicação:", errImg);
        return res.json({
          respostaFinal: "⚠️ O serviço de imagens da NVIDIA retornou uma falha de conexão. Verifique suas credenciais de uso ou tente novamente em instantes.",
          auditoria: { deepseek: `Erro NVIDIA: ${errImg.message}`, gemma: "N/A", llama8b: "N/A", webRaw: "Falha de renderização" }
        });
      }
    }

    // DIRETRIZ MASTER TEXTUAL
    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial de elite, personalizado para responder de forma profunda, profissional e didática. Use sempre português (PT-BR) e honre sua identidade Cactus.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA ATIVA]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[DIRETRIZ DE ESTILO]:\n${customInstructions}`;
    if (pesquisaWeb) {
      dadosInternet = await buscarNaWeb(ultimaMensagem);
      sistemaTexto += `\n\n[INTERNET CONTEXTO]:\n${dadosInternet}`;
    }

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];

    // ISOLAMENTO COMPLETO DE VARIÁVEIS POR FLUXO LÓGICO
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Engine] Fluxo Multimodal com imagem ativo.");
      
      const promptVisaoPuro = [
        {
          role: "user",
          content: [
            { type: "text", text: `Você é os olhos do Cactus. Analise detidamente a imagem e responda à solicitação em PORTUGUÊS: "${ultimaMensagem}". Leia e processe todas as informações visíveis.` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      const promptTextoCego = [
        { role: "system", content: sistemaTexto + "\n\n[AVISO]: O usuário enviou uma imagem. Você é o modelo de suporte de texto puro e não tem acesso aos olhos de visão do Cactus. Aguarde a consolidação do relatório principal." },
        ...historicoSanitizado
      ];

      const [resVision, resDeep, resLlama] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(tratarErroPromessa("Vision-11B")),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(tratarErroPromessa("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(tratarErroPromessa("Llama-8B"))
      ]);

      const txtVision = resVision.error ? resVision.message : (resVision.choices?.[0]?.message?.content || "Sem resposta.");
      const txtDeep = resDeep.error ? resDeep.message : (resDeep.choices?.[0]?.message?.content || "Sem resposta.");
      const txtLlama = resLlama.error ? resLlama.message : (resLlama.choices?.[0]?.message?.content || "Sem resposta.");

      const promptJuiz = `Você é o Juiz do Cactus. Avalie os relatórios e retorne o melhor resultado em PORTUGUÊS (PT-BR). Dê preferência absoluta à Opção 1 (Visão).\n\nOpção 1: ${txtVision}\nOpção 2: ${txtDeep}\nOpção 3: ${txtLlama}`;
      
      const chamadaJuiz = await nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: [{ role: "user", content: promptJuiz }] }).catch(() => null);
      const respostaVencedora = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : txtVision;

      return res.json({
        respostaFinal: respostaVencedora,
        auditoria: { deepseek: txtVision, gemma: txtDeep, llama8b: txtLlama, webRaw: `Arquivo Visual Processado: ${arquivoAnexo.nome}` }
      });

    } else {
      console.log("[Cactus-Engine] Fluxo Textual puro ativo.");

      const [resDeep, resLlama8b, resLlama70b] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(tratarErroPromessa("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-8B")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(tratarErroPromessa("Llama-70B"))
      ]);

      const txtDeep = resDeep.error ? resDeep.message : (resDeep.choices?.[0]?.message?.content || "Sem resposta.");
      const txtLlama8b = resLlama8b.error ? resLlama8b.message : (resLlama8b.choices?.[0]?.message?.content || "Sem resposta.");
      const txtLlama70b = resLlama70b.error ? resLlama70b.message : (resLlama70b.choices?.[0]?.message?.content || "Sem resposta.");

      const promptJuizTextual = `Você é o Juiz do Cactus. Escolha a resposta com melhor profundidade intelectual e científica. Retorne APENAS o texto limpo da escolhida.\n\nOpção 1: ${txtDeep}\nOpção 2: ${txtLlama8b}\nOpção 3: ${txtLlama70b}`;
      
      const chamadaJuizTextual = await nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: [{ role: "user", content: promptJuizTextual }] }).catch(() => null);
      const respostaVencedoraTextual = (chamadaJuizTextual && chamadaJuizTextual.choices?.[0]?.message?.content) ? chamadaJuizTextual.choices[0].message.content : txtDeep;

      return res.json({
        respostaFinal: respostaVencedoraTextual,
        auditoria: { deepseek: txtDeep, gemma: txtLlama8b, llama8b: txtLlama70b, webRaw: "Processamento Textual Puro" }
      });
    }

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus] Servidor restaurado operando na porta ${PORT}`));
