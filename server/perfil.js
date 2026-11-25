// O que é próprio do ramo de cada empresa. Empresa nova nasce no perfil "padrao" (neutro) e cada uma ajusta o dela
// nos Ajustes (base de conhecimento, respostas prontas, fluxos). A AgroVox (sinais de GPS agrícola) usa o perfil
// "agrovox": tudo continua exatamente como sempre foi para ela.
// Qual perfil a empresa usa fica no ajuste "perfil" do banco dela (o banco que já existia antes ganhou "agrovox").
import { getSetting } from './db.js';

const PADRAO = {
  // tradução: de que tipo de empresa são os clientes e exemplos de nomes de produto que não se traduzem
  ramo: '',
  exemplosModelos: '',
  // atendente da IA com tabelas (imagens): o que o cliente recebeu e o que a IA precisa descobrir
  agente: {
    contexto: 'O cliente está respondendo uma mensagem nossa no WhatsApp.',
    objetivo: 'Seu objetivo: entender qual produto ou serviço ele procura (veja a base de conhecimento) para mandar a TABELA DE PREÇO certa.',
    exemploLegenda: 'Segue a tabela 😊 Qual opção fica melhor para você?',
    semModelo: 'Perguntou preço/valor sem dizer o que procura: pergunte qual produto ou modelo de forma natural. Não comece com "Ótimo".',
    semInteresse: 'Não tem interesse, pediu para parar ou é engano',
    escolha: 'Escolha tabela só quando a conversa deixar claro um produto ou modelo que bate com ela; no máximo 2.',
  },
  // contato novo que chega por anúncio: nome salvo como "<prefixo> <nome do perfil>" (vazio = só o nome)
  prefixoAnuncio: '',
  // palavras no começo do nome que não são o nome da pessoa (ex.: "Agro Eduardo" -> "Eduardo")
  prefixosNome: [],
  respostasProntas: [],
  // fluxos e tabelas de exemplo criados na primeira vez (só no perfil da AgroVox)
  fluxosIniciais: false,
  conhecimento: `Empresa: (nome, site e Instagram)
O que vendemos: (produtos e serviços, em poucas linhas)
Diferenciais: (por que comprar com a gente)
Pagamento: (formas e prazos)
Para passar o valor certo precisamos saber: (o que perguntar ao cliente)

PREÇOS: (preencha aqui. Enquanto estiver vazio, a IA passa para um atendente quando o cliente pedir valor.)`,
  exemploEmail: 'contato@suaempresa.com.br',
  // texto que já vem escrito quando o cliente clica no botão do WhatsApp do e-mail
  textoWhatsappEmail: 'Olá! Vim pelo e-mail e quero saber mais.',
  assinaturaAlt: 'Mascote da empresa',
};

const AGROVOX = {
  ...PADRAO,
  ramo: 'de sinais de GPS agrícola',
  exemplosModelos: 'StarFire 6000, NAV 900, Gen 4',
  agente: {
    contexto: 'O cliente recebeu nossa mensagem oferecendo sinal de correção para piloto automático (John Deere e Trimble) e está respondendo no WhatsApp.',
    objetivo: 'Seu objetivo: descobrir o modelo do equipamento dele (principalmente a ANTENA; veja na base de conhecimento o que é antena e o que é monitor) para mandar a TABELA DE PREÇO certa.',
    exemploLegenda: 'Segue a tabela da StarFire 6000 😊 Qual plano fica melhor pro senhor?',
    semModelo: 'Perguntou preço/valor sem dizer o modelo: peça o modelo da antena (ou uma foto) de forma natural. Não comece com "Ótimo".',
    semInteresse: 'Não tem interesse, não usa piloto, pediu para parar ou é engano',
    escolha: 'Escolha tabela só quando a conversa deixar claro um modelo (antena ou monitor) que bate com ela; no máximo 2.',
  },
  prefixoAnuncio: 'Agro Sinal',
  prefixosNome: ['agro sinal', 'agro revenda sinal', 'agro', 'atualize'],
  respostasProntas: [
    { title: 'Site', pt: 'Conheça a AgroVox: https://www.agro-vox.com 🌱', es: 'Conozca AgroVox: https://www.agro-vox.com 🌱' },
    { title: 'Pagamento no cartão', pt: 'O pagamento pode ser feito no cartão de crédito. 💳', es: 'El pago se puede hacer con tarjeta de crédito. 💳' },
    { title: 'Pagamento em cripto', pt: 'Também aceitamos pagamento em criptomoedas.', es: 'También aceptamos pago con criptomonedas.' },
    { title: 'Sinais Trimble (diferença)',
      pt: 'Os sinais da Trimble:\n📡 *RangePoint* (± 15 cm): pulverização, adubação a lanço e preparo de solo. É o mais barato.\n📡 *CenterPoint* (± 4 cm): plantio, colheita e qualquer serviço que precisa de linha reta e repetível. O sinal leva alguns minutos para firmar.\n📡 *CenterPoint Fast* (± 2,5 cm): a mesma aplicação do CenterPoint, só que firma bem mais rápido (perto de 1 minuto) e é um pouco mais preciso. Para quem não pode esperar no começo do dia.',
      es: 'Las señales de Trimble:\n📡 *RangePoint* (± 15 cm): pulverización, fertilización al voleo y preparación de suelo. Es la más económica.\n📡 *CenterPoint* (± 4 cm): siembra, cosecha y cualquier trabajo que necesite líneas rectas y repetibles. La señal tarda unos minutos en estabilizarse.\n📡 *CenterPoint Fast* (± 2,5 cm): el mismo uso que CenterPoint, pero se estabiliza mucho más rápido (alrededor de 1 minuto) y es un poco más precisa. Ideal para quien no puede esperar al empezar el día.' },
  ],
  fluxosIniciais: true,
  conhecimento: `Empresa: AgroVox (site www.agro-vox.com, Instagram @agrovoxtech).
O que vendemos: sinal de correção para piloto automático / GPS agrícola, com ativação via código (sem precisar levar o equipamento).
Sinais John Deere: SF2, SF3, SF-RTK e ativação SF3 Ready.
Sinais Trimble: CenterPoint RTX e RangePoint RTX.
Desconto: até 50% (o desconto varia por sinal).
Precisão: até 2,5 cm (depende do sinal).
Pagamento: cartão, com prazo.
Suporte de quem é do campo.
Para passar o valor certo precisamos do modelo da antena (ex.: StarFire 6000, 7000) e do monitor (ex.: 4600, 4640, G5) — ou uma foto do monitor.

PREÇOS: (preencha aqui a tabela de valores por sinal e prazo. Enquanto estiver vazio, a IA passa para um atendente quando o cliente pedir valor.)`,
  exemploEmail: 'contato@agro-vox.com',
  textoWhatsappEmail: 'Olá! Vim pelo e-mail e quero saber o valor do sinal.',
  assinaturaAlt: 'Satelito, mascote da AgroVox',
};

export const PERFIS = { padrao: PADRAO, agrovox: AGROVOX };
export const perfil = () => PERFIS[getSetting('perfil', 'padrao')] || PADRAO;

// Tira do começo do nome as palavras do perfil (ex.: "Agro Sinal Maria" -> "Maria"). Mais longas primeiro.
export function semPrefixo(name) {
  const n = String(name || '').trim();
  const p = [...perfil().prefixosNome].sort((a, b) => b.length - a.length)
    .find((x) => n.toLowerCase().startsWith(`${x} `));
  return p ? n.slice(p.length).trim() : n;
}
