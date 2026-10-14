// Consulta de CNPJ na BrasilAPI (gratuita). Devolve nome, situação, natureza jurídica e endereço no formato da NFE.io.

async function consultarCnpj(cnpj) {
  // Sem User-Agent próprio o firewall da BrasilAPI bloqueia o fetch do Node (HTTP 403, visto em 13/10/2026).
  const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
    headers: { 'User-Agent': 'fluxo-nfs/1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 404) return { nome: null, situacao: 'NAO_ENCONTRADO', endereco: null };
  if (!r.ok) return null; // indisponível: o fluxo trata como não consultado
  const d = await r.json();
  return {
    nome: d.razao_social,
    situacao: d.descricao_situacao_cadastral,
    // Ex.: 1015 "Órgão Público do Poder Executivo Federal" (grupo 1 = administração pública).
    natureza_juridica: d.codigo_natureza_juridica ? String(d.codigo_natureza_juridica) : null,
    natureza_juridica_descricao: d.natureza_juridica || null,
    endereco: {
      country: 'BRA',
      postalCode: String(d.cep || '').replace(/\D/g, ''),
      street: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' '),
      number: d.numero || 'S/N',
      additionalInformation: d.complemento || '',
      district: d.bairro,
      city: { code: String(d.codigo_municipio_ibge), name: d.municipio },
      state: d.uf,
    },
  };
}

module.exports = { consultarCnpj };
