require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const GROQ_KEY = process.env.GROQ_KEY;
const PASTA_PDFS = './pdfs';

// Cada manual guardado separadamente
let manuais = [];
let totalManuais = 0;

async function extrairTextoPDF(caminho) {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(caminho));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let texto = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texto += content.items.map(item => item.str).join(' ') + '\n';
  }
  return texto;
}

async function carregarPDFs() {
  console.log('📚 Carregando PDFs...');
  if (!fs.existsSync(PASTA_PDFS)) {
    fs.mkdirSync(PASTA_PDFS);
    console.log('📁 Pasta /pdfs criada.');
  }
  const arquivos = fs.readdirSync(PASTA_PDFS).filter(f => f.toLowerCase().endsWith('.pdf'));
  if (arquivos.length === 0) { console.log('⚠️ Nenhum PDF encontrado'); return; }
  for (const arquivo of arquivos) {
    try {
      const texto = await extrairTextoPDF(path.join(PASTA_PDFS, arquivo));
      manuais.push({ nome: arquivo, conteudo: texto });
      totalManuais++;
      console.log(`✅ ${arquivo}`);
    } catch (err) {
      console.log(`❌ ${arquivo}: ${err.message}`);
    }
  }
  console.log(`📖 ${totalManuais} manual(is) carregado(s).`);
}

// Busca os manuais mais relevantes para a pergunta
function buscarManuaisRelevantes(pergunta, maxChars = 20000) {
  const palavras = pergunta.toLowerCase().split(/\s+/);
  
  // Pontua cada manual pela quantidade de palavras da pergunta que aparecem nele
  const pontuados = manuais.map(manual => {
    const conteudoLower = manual.conteudo.toLowerCase();
    const nomeLower = manual.nome.toLowerCase();
    let pontos = 0;
    palavras.forEach(palavra => {
      if (palavra.length < 3) return;
      if (nomeLower.includes(palavra)) pontos += 10;
      const ocorrencias = (conteudoLower.match(new RegExp(palavra, 'g')) || []).length;
      pontos += ocorrencias;
    });
    return { ...manual, pontos };
  });

  // Ordena pelos mais relevantes
  pontuados.sort((a, b) => b.pontos - a.pontos);

  // Monta contexto até o limite de caracteres
  let contexto = '';
  for (const manual of pontuados) {
    const bloco = `\n\n=== MANUAL: ${manual.nome} ===\n${manual.conteudo}`;
    if (contexto.length + bloco.length > maxChars) break;
    contexto += bloco;
  }

  return contexto;
}

function chamarGroq(pergunta, contexto) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Você é um assistente de suporte técnico N1. Responda APENAS com base nos manuais abaixo. Se não encontrar a informação, diga: "Não encontrei essa informação nos manuais disponíveis."\n\n${contexto}`
        },
        { role: 'user', content: pergunta }
      ],
      temperature: 0.3,
      max_tokens: 1024
    });

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.choices[0].message.content);
        } catch (e) {
          reject(new Error('Resposta inválida: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

app.post('/perguntar', async (req, res) => {
  const { pergunta } = req.body;
  if (!pergunta) return res.json({ resposta: 'Digite uma pergunta.' });
  if (manuais.length === 0) return res.json({ resposta: '⚠️ Nenhum manual carregado.' });
  try {
    const contexto = buscarManuaisRelevantes(pergunta);
    const resposta = await chamarGroq(pergunta, contexto);
    res.json({ resposta });
  } catch (err) {
    console.error('ERRO GROQ:', err.message);
    res.json({ resposta: '❌ Erro: ' + err.message });
  }
});

app.get('/status', (req, res) => {
  res.json({ manuais: totalManuais, online: true });
});

carregarPDFs().then(() => {
  app.listen(3000, () => console.log('🚀 Servidor rodando em http://localhost:3000'));
});