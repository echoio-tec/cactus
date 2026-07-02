const express = require('express');
const cors = require('cors');
const supabase = require('./src/config/supabase');
const promptController = require('./src/controllers/promptController');

const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

// INTERFACE DE SESSÕES DIRETAMENTE ATADA AO CLIENT SUPABASE DE CONFIG
app.get('/api/chats', async (req, res) => {
  const { data, error } = await supabase.from('chats').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

app.post('/api/chats', async (req, res) => {
  const { title } = req.body;
  const { data, error } = await supabase.from('chats').insert({ title: title || 'Novo Chat' }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

app.delete('/api/chats/:id', async (req, res) => {
  const { error } = await supabase.from('chats').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ success: true });
});

app.get('/api/chats/:id/mensagens', async (req, res) => {
  const { data, error } = await supabase.from('messages').select('role, content, auditoria').eq('chat_id', req.params.id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

// ENCAMINHAMENTO MODULAR DO CONTROLLER
app.post('/api/perguntar', promptController.processarPergunta);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cactus Central] Operando sob Arquitetura Modular na porta ${PORT}`));