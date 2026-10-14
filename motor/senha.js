// Senhas do painel: scrypt (node:crypto) com sal aleatório. Guarda "scrypt$N$sal$hash".

const crypto = require('node:crypto');

const N = 16384;
const TAMANHO = 64;

function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(senha), sal, TAMANHO, { N });
  return `scrypt$${N}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

function conferir(senha, guardado) {
  const partes = String(guardado || '').split('$');
  if (partes.length !== 4 || partes[0] !== 'scrypt') return false;
  const esperado = Buffer.from(partes[3], 'base64');
  const hash = crypto.scryptSync(String(senha), Buffer.from(partes[2], 'base64'), esperado.length, { N: Number(partes[1]) });
  return crypto.timingSafeEqual(hash, esperado);
}

// Senha nova para entregar ao colaborador (ele troca no painel, em "Minha senha").
function gerarSenha() {
  return crypto.randomBytes(12).toString('base64url');
}

module.exports = { gerarHash, conferir, gerarSenha };
