const supabase = require('../config/supabase');
const aiService = require('../services/aiService');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');

function verificarMensagemTrivial(texto) {
  const t = texto.toLowerCase().trim();
  if (!t) return true;
  const termosTriviais = ['oi', 'ola', 'olá', 'tudo bem', 'tudo bom', 'bom dia', 'boa tarde', 'boa noite', 'obrigado', 'obrigada', 'valeu', 'show', 'ok', 'blz', 'tchau', 'vlw', 'sim', 'nao', 'não', 'ajuda'];
  return t.split(' ').length <= 2 || termosTriviais.some(termo => t === termo || t.startsWith(termo + ' '));
}

async function processarPergunta(req, res) {
  const { chatId, ultimaMensagem, customInstructions, memoryContext, pesquisaWeb, arquivoAnexo } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId obrigatório.' });

  const textoMinusculo = ultimaMensagem.toLowerCase().trim();
  let sistemaTexto = "Seu nome é Cactus. Responda em português de forma profunda, exata e analítica.";
  if (memoryContext) sistemaTexto += `\n\n[MEMÓRIA]: ${memoryContext}`;
  if (customInstructions) sistemaTexto += `\n\n[DIRETRIZ]: ${customInstructions}`;

  // 1. FAST-PATH: Avaliação imediata de mensagens simples (Não encosta no banco antes da resposta)
  if (verificarMensagemTrivial(ultimaMensagem) && !arquivoAnexo && !pesquisaWeb) {
    try {
      const respostaExpress = await aiService.executarCanalExpress(sistemaTexto, ultimaMensagem);
      const auditTrivial = { deepseek: "Bypass", gemma: "Bypass", llama8b: respostaExpress, webRaw: "Fast-Path Ativo" };

      // Execução assíncrona paralela em background para não atrasar a resposta HTTP
      supabase.from('messages').insert([
        { chat_id: chatId, role: 'user', content: ultimaMensagem },
        { chat_id: chatId, role: 'assistant', content: respostaExpress, auditoria: auditTrivial }
      ]).then(() => {
        return supabase.from('chats').select('title').eq('id', chatId).single();
      }).then(({ data }) => {
        if (data && data.title === 'Novo Chat') {
          supabase.from('chats').update({ title: ultimaMensagem.substring(0, 20) }).eq('id', chatId).catch(() => null);
        }
      }).catch(() => null);

      return res.json({ respostaFinal: respostaExpress, auditoria: auditTrivial });
    } catch (err) {
      console.error(err.message);
    }
  }

  // 2. PARSING E INGESTÃO SÍNCRONA DE ARQUIVOS ANEXOS
  let flagDocumentoAtivo = false;
  let logDocNome = "";

  if (arquivoAnexo && arquivoAnexo.tipo === 'documento' && arquivoAnexo.conteudo) {
    flagDocumentoAtivo = true;
    logDocNome = arquivoAnexo.nome;
    try {
      await supabase.from('chat_documents').delete().eq('chat_id', chatId);
      
      const partesBase64 = arquivoAnexo.conteudo.split(';base64,');
      const dadosBrutos = partesBase64[1] || partesBase64[0]; 
      const bufferArquivo = Buffer.from(dadosBrutos, 'base64');
      const nomeMinusculo = arquivoAnexo.nome.toLowerCase();
      let textoExtraido = "";

      if (nomeMinusculo.endsWith('.pdf')) {
        const parsedPdf = await pdfParse(bufferArquivo); textoExtraido = parsedPdf.text;
      } else if (nomeMinusculo.endsWith('.docx')) {
        const m = await mammoth.extractRawText({ buffer: bufferArquivo }); textoExtraido = m.value;
      } else if (nomeMinusculo.endsWith('.xlsx')) {
        const workbook = XLSX.read(bufferArquivo, { type: 'buffer' });
        workbook.SheetNames.forEach(s => { textoExtraido += XLSX.utils.sheet_to_csv(workbook.Sheets[s]); });
      }

      const textoFinalDoc = textoExtraido.replace(/\s+/g, ' ').trim().substring(0, 25000);
      
      await supabase.from('chats').update({ title: arquivoAnexo.nome }).eq('id', chatId);
      await supabase.from('chat_documents').insert({ chat_id: chatId, file_name: arquivoAnexo.nome, extracted_text: textoFinalDoc });
    } catch (errParser) {
      console.error("Erro extração: ", errParser.message);
    }
  }

  // 3. SELEÇÃO DO HISTÓRICO REAL DO SUPABASE
  const { data: docs } = await supabase.from('chat_documents').select('file_name, extracted_text').eq('chat_id', chatId);
  let conteudoDoDocumentoTexto = "";
  if (docs && docs.length > 0) {
    docs.forEach(d => {
      conteudoDoDocumentoTexto += d.extracted_text;
      sistemaTexto += `\n\n[CONTEÚDO DO DOCUMENTO ANEXADO EM ANÁLISE]:\n${d.extracted_text}`;
    });
  }

  const { data: historicoBanco } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: true });
  const promptTextualPuro = [{ role: "system", content: sistemaTexto }, ...(historicoBanco || []), { role: "user", content: ultimaMensagem }];

  // 4. ROTEADOR DE FLUXO GRÁFICO (IMAGENS)
  const ehPromptGrafico = textoMinusculo.startsWith('/gerar') || textoMinusculo.startsWith('/imagem') || textoMinusculo.includes('gerar imagem') || textoMinusculo.includes('gere uma imagem') || textoMinusculo.startsWith('desenhe') || textoMinusculo.includes('crie uma imagem');
  if (ehPromptGrafico) {
    let promptImagem = ultimaMensagem.replace(/^(gerar uma imagem|gerar imagem|gere uma imagem|gere imagem|desenhe|crie uma imagem de|crie uma imagem|\/gerar|\/imagem)\s*/i, '').trim();
    if (conteudoDoDocumentoTexto) promptImagem += ` baseado no contexto técnico: ${conteudoDoDocumentoTexto.substring(0, 500)}`;

    const resultadoGrafico = await aiService.executarGeracaoGrafica(promptImagem);
    const auditGrafica = { deepseek: "SDXL Core", gemma: "N/A", llama8b: "N/A", webRaw: "Pipeline de Imagem Ativo" };

    await supabase.from('messages').insert([{ chat_id: chatId, role: 'user', content: ultimaMensagem }, { chat_id: chatId, role: 'assistant', content: resultadoGrafico, auditoria: auditGrafica }]);
    return res.json({ respostaFinal: resultadoGrafico, auditoria: auditGrafica });
  }

  // 5. CANAL DEDICADO PARA DOCUMENTOS LARGOS E TRANSCRIÇÕES
  const ehTarefaPesadaDeDocumento = flagDocumentoAtivo || (docs && docs.length > 0) || textoMinusculo.includes('transcreva') || textoMinusculo.includes('questões') || textoMinusculo.includes('exercício') || textoMinusculo.includes('resuma');
  if (ehTarefaPesadaDeDocumento) {
    const respostaDedicada = await aiService.executarCanalDedicadoDocumentos(promptTextualPuro);
    const logDoc = `[Canal Dedicado] Processado via Llama-3.3-70B Core.`;
    const auditDedicado = { deepseek: "Ignorado (Canal Dedicado)", gemma: "Ignorado (Canal Dedicado)", llama8b: respostaDedicada, webRaw: logDoc };

    await supabase.from('messages').insert([{ chat_id: chatId, role: 'user', content: ultimaMensagem }, { chat_id: chatId, role: 'assistant', content: respostaDedicada, auditoria: auditDedicado }]);
    return res.json({ respostaFinal: respostaDedicada, auditoria: auditDedicado });
  }

  // 6. BATALHA TRIPLA PARA PERGUNTAS COMPLEXAS ABERTAS
  if (pesquisaWeb) {
    const dadosInternet = await buscarNaWeb(ultimaMensagem);
    promptTextualPuro[0].content += `\n\n[DADOS INTERNET]:\n${dadosInternet}`;
  }

  const { respostaConsolidada, txt1, txt2, txt3 } = await aiService.executarBatalhaTripla(promptTextualPuro, ultimaMensagem);
  const logFinal = `[Batalha Clássica] Ingestão Concluída`;
  const auditBatalha = { deepseek: txt1, gemma: txt2, llama8b: txt3, webRaw: logFinal };

  await supabase.from('messages').insert([{ chat_id: chatId, role: 'user', content: ultimaMensagem }, { chat_id: chatId, role: 'assistant', content: respostaConsolidada, auditoria: auditBatalha }]);

  const { data: chatAtual } = await supabase.from('chats').select('title').eq('id', chatId).single();
  if (chatAtual && chatAtual.title === 'Novo Chat') {
    await supabase.from('chats').update({ title: ultimaMensagem.substring(0, 25) }).eq('id', chatId);
  }

  return res.json({ respostaFinal: respostaConsolidada, auditoria: auditBatalha });
}

module.exports = {
  processarPergunta
};