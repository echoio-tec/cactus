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
  timeout: 30000 // Limite de 30 segundos para evitar travamento infinito
});

// Tratamento defensivo contra falhas assíncronas de IAs individuais
function encapsularErroModulo(nomeModelo) {
  return (err) => ({ error: true, message: `Módulo ${nomeModelo} offline: ${err.message}` });
}

// 🌾 BANCO DE ANCORAGEM ZOOTÉCNICA E AGRONÉGOCIO (MOCK RAG)
const BASE_CONHECIMENTO_AGRO = {
  nutricao_aves: "Tabela Técnica (Embrapa/NRC): Frangos de corte na fase inicial (1 a 21 dias) exigem: Energia Metabolizável: 2.950 a 3.000 kcal/kg. Proteína Bruta: 21% a 22%. Lisina Digestível: 1,22%. Metionina Digestível: 0,49%. Cálcio: 0,92%. Fósforo Disponível: 0,43%.",
  nutricao_bovinos: "Padrão de Confinamento Bovino: Relação volumoso:concentrado para terminação geralmente varia de 20:80 a 10:90. Exigência média de MS (Matéria Seca): 2,3% a 2,5% do Peso Vivo (PV). Ganho de peso esperado em dietas de alto grão: 1,4 kg a 1,8 kg/dia.",
  fertilidade_solo: "Recomendações de Fertilidade (Semiárido/Zinco): O nível crítico de Zinco (Zn) no solo pelo extrator Mehlich-1 é de 1,0 a 1,2 mg/dm³. Deficiências em plantas causam encurtamento de entrenós (rosetamento) e clorose listrada interveinal. Fontes: Sulfato de Zinco (20-22% Zn) ou Óxido de Zinco (50-80% Zn).",
  pastagem: "Manejo de Capim-Panicum (Mombaça/Colonião): Altura de entrada no pasto: 90 cm. Altura de saída (resíduo): 30 a 40 cm. Período de descanso médio no período chuvoso: 28 a 32 dias. Superar a altura de entrada reduz o valor nutritivo devido ao alongamento de colmo."
};

// Mecanismo de busca de dados científicos locais
function recuperarContextoZootecnico(pergunta) {
  const p = pergunta.toLowerCase();
  let contextoAnexo = "\n\n[NENHUM DADO TÉCNICO COMPLEMENTAR ENCONTRADO NO BANCO LOCAL]";

  if (p.includes("ave") || p.includes("frango") || p.includes("pintinho")) {
    contextoAnexo = `\n\n[DADO CIENTÍFICO ANCORADO - REQUISITO DO SISTEMA]:\n${BASE_CONHECIMENTO_AGRO.nutricao_aves}`;
  } else if (p.includes("bovino") || p.includes("boi") || p.includes("vaca") || p.includes("confinamento")) {
    contextoAnexo = `\n\n[DADO CIENTÍFICO ANCORADO - REQUISITO DO SISTEMA]:\n${BASE_CONHECIMENTO_AGRO.nutricao_bovinos}`;
  } else if (p.includes("solo") || p.includes("zinco") || p.includes("adub") || p.includes("deficiência")) {
    contextoAnexo = `\n\n[DADO CIENTÍFICO ANCORADO - REQUISITO DO SISTEMA]:\n${BASE_CONHECIMENTO_AGRO.fertilidade_solo}`;
  } else if (p.includes("pasto") || p.includes("capim") || p.includes("mombaça") || p.includes("lotação")) {
    contextoAnexo = `\n\n[DADO CIENTÍFICO ANCORADO - REQUISITO DO SISTEMA]:\n${BASE_CONHECIMENTO_AGRO.pastagem}`;
  }
  return contextoAnexo;
}

// Sanitização obrigatória para manter a alternância correta de turnos no histórico
function optimizarHistorico(historico) {
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

app.post('/api/perguntar', async (req, res) => {
  const { historico, customInstructions, memoryContext, arquivoAnexo } = req.body;

  if (!historico || historico.length === 0) return res.status(400).json({ error: 'Histórico ausente.' });
  
  const historicoSanitizado = optimizarHistorico(historico);
  const ultimaMensagem = historicoSanitizado.length > 0 ? historicoSanitizado[historicoSanitizado.length - 1].content : '';

  try {
    // 🎨 PIPELINE GRÁFICO: GERADOR DE IMAGENS (SDXL)
    if (ultimaMensagem.toLowerCase().startsWith('/gerar') || ultimaMensagem.toLowerCase().startsWith('/imagem')) {
      const promptImagem = ultimaMensagem.replace(/^\/(gerar|imagem)\s*/i, '');
      if (!promptImagem) return res.status(400).json({ error: "Especifique o prompt. Ex: /gerar um touro nelore" });

      console.log(`[Cactus-Graphics] Gerando imagem para: "${promptImagem}"`);
      try {
        const responseImg = await nvidia.images.generate({
          model: "stabilityai/stable-diffusion-xl",
          prompt: promptImagem
        });
        
        return res.json({
          respostaFinal: `🎨 Aqui está a imagem gerada para **"${promptImagem}"**:\n\n![Imagem Gerada](${responseImg.data[0].url})`,
          auditoria: { deepseek: "Renderizado via SDXL", gemma: "N/A", llama8b: "N/A", webRaw: "Módulo Gráfico Ativo" }
        });
      } catch (errImg) {
        return res.json({
          respostaFinal: "⚠️ O serviço de geração gráfica da NVIDIA falhou ou atingiu o limite de requisições. Tente novamente.",
          auditoria: { deepseek: `Erro: ${errImg.message}`, gemma: "N/A", llama8b: "N/A", webRaw: "Falha de renderização" }
        });
      }
    }

    // 🔬 DISPARO DO MOTOR DE CONHECIMENTO CIENTÍFICO E PARCENTAGENS
    const dadosCientificosLocais = recuperarContextoZootecnico(ultimaMensagem);

    let sistemaTexto = "Seu nome é Cactus. Você é um assistente de inteligência artificial avançado, forte, resiliente e prestativo. Nunca diga que você é o DeepSeek, Google, Gemma ou Llama. Responda sempre com orgulho que você é o Cactus e que foi projetado de forma personalizada como um agregador inteligente de alto nível. Se dados científicos forem fornecidos no bloco [DADO CIENTÍFICO ANCORADO], use-os como verdade conceitual absoluta.";

    if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA ATIVA SOBRE O USUÁRIO]:\n${memoryContext}`;
    if (customInstructions) sistemaTexto += `\n\n[INSTRUÇÕES DE ESTILO]:\n${customInstructions}`;
    sistemaTexto += dadosCientificosLocais;

    const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...historicoSanitizado];
    let chamadaFiltro1, chamadaFiltro2, chamadaFiltro3;

    // 👁️ FLUXO MULTIMODAL (IMAGEM ANEXADA)
    if (arquivoAnexo && arquivoAnexo.tipo === 'imagem') {
      console.log("[Cactus-Core] Processando pipeline multimodal.");
      const promptVisaoPuro = [
        {
          role: "user",
          content: [
            { type: "text", text: `Você é a capacidade visual do Cactus. Analise meticulosamente esta imagem e extraia dados, tabelas e textos para responder à ordem: "${ultimaMensagem}"` },
            { type: "image_url", image_url: { url: arquivoAnexo.conteudo } }
          ]
        }
      ];

      const promptTextoCego = [
        { role: "system", content: sistemaTexto + "\n\n[ALERTA]: O usuário enviou uma imagem agora. Como você não possui olhos neste barramento, informe estritamente que está aguardando o relatório visual do Filtro 1." },
        ...historicoSanitizado
      ];

      [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
        nvidia.chat.completions.create({ model: "meta/llama-3.2-11b-vision-instruct", messages: promptVisaoPuro }).catch(encapsularErroModulo("Llama-Vision")),
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextoCego }).catch(encapsularErroModulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextoCego }).catch(encapsularErroModulo("Llama-8B"))
      ]);
    } else {
      // 📝 FLUXO TEXTUAL PADRÃO
      console.log("[Cactus-Core] Processando pipeline textual padrão.");
      [chamadaFiltro1, chamadaFiltro2, chamadaFiltro3] = await Promise.all([
        nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch(encapsularErroModulo("DeepSeek-Flash")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch(encapsularErroModulo("Llama-8B")),
        nvidia.chat.completions.create({ model: "meta/llama-3.1-70b-instruct", messages: promptTextualPuro }).catch(encapsularErroModulo("Llama-70B"))
      ]);
    }

    const txt1 = chamadaFiltro1.error ? chamadaFiltro1.message : (chamadaFiltro1.choices?.[0]?.message?.content || "Vazio.");
    const txt2 = chamadaFiltro2.error ? chamadaFiltro2.message : (chamadaFiltro2.choices?.[0]?.message?.content || "Vazio.");
    const txt3 = chamadaFiltro3.error ? chamadaFiltro3.message : (chamadaFiltro3.choices?.[0]?.message?.content || "Vazio.");

    // ⚖️ ARBITRAGEM DO JUIZ ACELERADO (LLAMA 3.3 70B)
    const promptJuiz = `
Você é o Juiz do Cactus. Avalie as três respostas e selecione a melhor, mais completa e profunda resposta estruturada em PORTUGUÊS (PT-BR).
Se houver uma imagem em análise, dê preferência absoluta para a Opção 1. Retorne APENAS a resposta vencedora limpa, sem metalinguagem.

Pergunta: "${ultimaMensagem}"
Opção 1: ${txt1}
Opção 2: ${txt2}
Opção 3: ${txt3}
    `;

    const chamadaJuiz = await nvidia.chat.completions.create({
      model: "meta/llama-3.3-70b-instruct",
      messages: [{ role: "user", content: promptJuiz }]
    }).catch(() => null);

    const respostaFinalConsolidada = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) ? chamadaJuiz.choices[0].message.content : txt1;

    res.json({
      respostaFinal: respostaFinalConsolidada,
      auditoria: { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: dadosCientificosLocais.trim() }
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Engine] Estável e operacional na porta ${PORT}`));
