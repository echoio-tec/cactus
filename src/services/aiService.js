const nvidia = require('../config/openai');

async function executarCanalExpress(sistemaTexto, ultimaMensagem) {
  const chamada = await nvidia.chat.completions.create({
    model: "meta/llama-3.1-8b-instruct",
    messages: [
      { role: "system", content: `${sistemaTexto}\nResponda de forma curta e direta em no máximo duas frases.` },
      { role: "user", content: ultimaMensagem }
    ],
    max_tokens: 120
  });
  return chamada.choices[0].message.content;
}

async function executarCanalDedicadoDocumentos(promptTextualPuro) {
  const chamada = await nvidia.chat.completions.create({
    model: "meta/llama-3.3-70b-instruct",
    messages: promptTextualPuro,
    max_tokens: 2500,
    temperature: 0.2
  });
  return chamada.choices[0].message.content;
}

async function executarGeracaoGrafica(promptImagem) {
  try {
    const responseImg = await nvidia.images.generate({ model: "stabilityai/stable-diffusion-xl", prompt: promptImagem });
    return `🎨 Aqui está a imagem gerada:\n\n![Imagem Gerada](${responseImg.data[0].url})`;
  } catch (err) {
    const urlReserva = `https://image.pollinations.ai/p/${encodeURIComponent(promptImagem)}?width=1024&height=1024&seed=${Date.now()}&enhance=true`;
    return `🎨 Aqui está a imagem gerada:\n\n![Imagem Gerada](${urlReserva})`;
  }
}

async function executarBatalhaTripla(promptTextualPuro, ultimaMensagem) {
  const [f1, f2, f3] = await Promise.all([
    nvidia.chat.completions.create({ model: "deepseek-ai/deepseek-v4-flash", messages: promptTextualPuro }).catch((e) => ({ error: true, message: e.message })),
    nvidia.chat.completions.create({ model: "meta/llama-3.1-8b-instruct", messages: promptTextualPuro }).catch((e) => ({ error: true, message: e.message })),
    nvidia.chat.completions.create({ model: "meta/llama-3.3-70b-instruct", messages: promptTextualPuro }).catch((e) => ({ error: true, message: e.message }))
  ]);

  const txt1 = f1.error ? `Erro DeepSeek: ${f1.message}` : f1.choices[0].message.content;
  const txt2 = f2.error ? `Erro Llama-8B: ${f2.message}` : f2.choices[0].message.content;
  const txt3 = f3.error ? `Erro Llama-70B: ${f3.message}` : f3.choices[0].message.content;

  const promptJuiz = `Determine a melhor resposta estruturada em português.\nPergunta: "${ultimaMensagem}"\nOpção 1: ${txt1}\nOpção 2: ${txt2}\nOpção 3: ${txt3}`;
  
  const chamadaJuiz = await nvidia.chat.completions.create({
    model: "meta/llama-3.3-70b-instruct",
    messages: [{ role: "user", content: promptJuiz }],
    max_tokens: 1200
  }).catch(() => null);

  const respostaConsolidada = (chamadaJuiz && chamadaJuiz.choices?.[0]?.message?.content) 
    ? chamadaJuiz.choices[0].message.content 
    : (!f2.error ? txt2 : (!f1.error ? txt1 : txt3));

  return { respostaConsolidada, txt1, txt2, txt3 };
}

module.exports = {
  executarCanalExpress,
  executarCanalDedicadoDocumentos,
  executarGeracaoGrafica,
  executarBatalhaTripla
};