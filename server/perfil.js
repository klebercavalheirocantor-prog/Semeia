// O que é próprio do ramo de cada empresa. Empresa nova nasce no perfil "padrao" (neutro) e cada uma ajusta o dela
// nos Ajustes (base de conhecimento, respostas prontas, fluxos). A AgroVox (sinais de GPS agrícola) usa o perfil
// "agrovox": tudo continua exatamente como sempre foi para ela.
// Qual perfil a empresa usa fica no ajuste "perfil" do banco dela (o banco que já existia antes ganhou "agrovox").
import { getSetting } from './db.js';

// Informações do piloto FJ Dynamics (também vão para a base de conhecimento da AgroVox no banco).
export const PILOTO = `PILOTO AUTOMÁTICO FJ DYNAMICS — modelo AT2 (a AgroVox é representante oficial da FJ Dynamics; só diga isso se perguntarem).
O que vem no kit: tela (terminal de controle), volante elétrico, antena receptora (receptor GNSS) e sensor de ângulo. Entregue instalado e testado.
Precisão: até 2,5 cm de passada, em qualquer terreno (usa GNSS + RTK). Funciona de 0,1 a 26 km/h.
Compatível com a maioria dos tratores, de várias marcas, e com uma ampla gama de implementos. Para confirmar, pergunte o modelo e o ano do trator.
Vantagens: menos falhas e sobreposição, economia de insumos, menos cansaço do operador e dá para trabalhar à noite sem ficar olhando para frente e para trás.
Funções: linhas retas, curvas, pivô, linha A+, cabeceira, gradagem diagonal; linha de condução (deixa os trilhos para a pulverização); salvar grupos de linhas e usar de novo; compensação de terreno (desnível); passa os dados do talhão entre máquinas por pendrive (formato GIS).
Sinais de correção que aceita: RTK, PPP e SBAS.
ISOBUS: controla implementos compatíveis pela própria tela (terminal virtual e controlador de tarefas).
Manobra automática de cabeceira (U-Turn automático): é uma função paga à parte; o valor um especialista passa.
Ficha técnica: tela 275 x 180 x 40 mm, alimentação 9–36 V, internet 4G/3G/2G, proteção IP65. Volante elétrico 410 x 410 x 135 mm, força (torque) de até 30 N·m, 12/24 V, proteção IP67, trabalha de -20 a 85 °C. Antena recebe GPS, GLONASS, BeiDou, Galileo e QZSS em várias frequências, proteção IP66.
A fábrica FJ Dynamics está em mais de 100 países, com mais de 200 mil máquinas usando a tecnologia.
Preço (promoção): de R$ 59.980 por R$ 29.990 (50% OFF). Esse valor NÃO inclui a instalação nem a Base RTK.
Cliente de fora do Brasil (Paraguai, Argentina ou quem escreve em espanhol): o preço é em dólar — de US$ 10.000 por US$ 5.000 (50% OFF); Base RTK opcional + US$ 1.670. Nunca passe o preço em reais para ele.
Instalação: cobrada à parte; o valor e a data um especialista passa (depende da cidade).
Base RTK (opcional): + R$ 9.990. É uma base que fica na fazenda e gera o próprio sinal: nunca mais paga sinal e liga quantos pilotos FJ Dynamics quiser. O cliente escolhe com ou sem a Base.
Sem a Base RTK: um especialista explica as opções de sinal.
Forma de pagamento, prazo de entrega e garantia: um especialista passa.
Para o orçamento precisamos: modelo e ano do trator, quantas máquinas, cidade/estado da fazenda e se quer a Base RTK.
Outros produtos FJ Dynamics que também vendemos (o foco é o AT2: ofereça sempre o AT2 primeiro): pilotos AG1, AT2 Lite, AS2, AH2, AT2 MAX e AT2 Ultra; controle de seção e de implementos; monitoramento de rendimento; bases e receptores RTK; câmeras e acessórios. Se o cliente pedir um desses, diga que também trabalhamos com ele e que um especialista passa os detalhes e o valor (acao "humano"). Não invente preço nem ficha técnica desses outros.`;

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
  ramo: 'de sinais de GPS agrícola e piloto automático',
  exemplosModelos: 'modelos de antena e de monitor (ex.: 6000, 4640)',
  agente: {
    contexto: 'A AgroVox vende dois produtos: (1) SINAL de correção para quem já tem piloto automático; (2) o PILOTO AUTOMÁTICO FJ Dynamics completo (kit novo), com a Base RTK opcional. O cliente está respondendo uma mensagem ou um anúncio nosso.',
    objetivo: `Primeiro entenda qual dos dois ele procura, pelo anúncio de onde veio (se houver) e pelo que ele escreveu. Anúncio ou conversa que fala de FJ Dynamics, Base RTK, kit de piloto, "piloto automático completo" ou de comprar um piloto = PILOTO.
- SINAL: descubra o modelo do MONITOR e da ANTENA dele (veja na base o que é antena e o que é monitor). Não passe valor de sinal: quando souber o equipamento, um atendente passa o valor. Se ele disser que não tem piloto automático, apresente em uma frase o piloto FJ Dynamics da promoção e pergunte se quer saber mais.
- PILOTO: quem quer comprar o piloto NÃO tem sinal nem piloto: NUNCA pergunte da antena, do monitor, do sinal atual nem peça foto deles. Tire as dúvidas com a seção PILOTO da base de conhecimento (pode confirmar o preço da promoção que está lá) e descubra, uma pergunta por vez: qual trator ele quer equipar (modelo e ano), quantas máquinas, a cidade/estado da fazenda e se quer a Base RTK. Quando tiver isso, ou se ele quiser fechar, saber da instalação, do prazo de entrega, da garantia ou da forma de pagamento, diga que um especialista vai continuar e use acao "humano".
Vá direto ao ponto: não explique o produto nem como funciona a não ser que o cliente pergunte. Nunca cite marcas de sinal nem de outros fabricantes; a única marca que você pode citar é FJ Dynamics.`,
    exemploLegenda: 'Segue a tabela 😊 Qual plano fica melhor pro senhor?',
    semModelo: 'Perguntou preço/valor sem dizer o que procura: se for o piloto, passe o valor da promoção que está na base; se for sinal, diga que depende do equipamento e peça o modelo do monitor e da antena (ou uma foto) de forma natural. Não comece com "Ótimo".',
    semInteresse: 'Não tem interesse, pediu para parar ou é engano',
    escolha: 'Escolha tabela só quando a conversa deixar claro um modelo (antena ou monitor) que bate com ela; no máximo 2.',
  },
  // contato que chega pelo anúncio do piloto FJ Dynamics é salvo como "Agro Piloto <nome>"
  // vai junto da base de conhecimento salva nos Ajustes (se ela ainda não tiver esse texto)
  conhecimentoExtra: PILOTO,
  prefixosPorAnuncio: [{ re: /fj\s*dynamics|base\s*rtk/i, prefixo: 'Agro Piloto' }],
  prefixoAnuncio: 'Agro Sinal',
  paisNoNome: true, // número do Paraguai/Argentina leva PY/AR depois do prefixo ("Agro Piloto PY Juan")
  prefixosNome: ['agro sinal', 'agro revenda sinal', 'agro piloto', 'agro', 'atualize'],
  respostasProntas: [
    { title: 'Site', pt: 'Conheça a AgroVox: https://www.agro-vox.com 🌱', es: 'Conozca AgroVox: https://www.agro-vox.com 🌱' },
    { title: 'Pagamento no cartão', pt: 'O pagamento pode ser feito no cartão de crédito. 💳', es: 'El pago se puede hacer con tarjeta de crédito. 💳' },
    { title: 'Pagamento em cripto', pt: 'Também aceitamos pagamento em criptomoedas.', es: 'También aceptamos pago con criptomonedas.' },
  ],
  fluxosIniciais: true,
  conhecimento: `Empresa: AgroVox (site www.agro-vox.com, Instagram @agrovox.br).
O que vendemos: (1) sinal de correção para piloto automático / GPS agrícola; (2) piloto automático FJ Dynamics completo.

SINAL
Desconto: até 50% (o desconto varia por sinal).
Precisão: até 2,5 cm (depende do sinal).
Pagamento: cartão, com prazo.
Suporte de quem é do campo.
Para passar o valor certo precisamos do modelo da antena e do monitor — ou uma foto. Nunca cite marcas.

PILOTO
${PILOTO}

PREÇOS DE SINAL: (preencha aqui a tabela de valores por sinal e prazo. Enquanto estiver vazio, a IA passa para um atendente quando o cliente pedir valor.)`,
  exemploEmail: 'contato@agro-vox.com',
  textoWhatsappEmail: 'Olá! Vim pelo e-mail e quero saber o valor do sinal.',
  assinaturaAlt: 'Satelito, mascote da AgroVox',
};

export const PERFIS = { padrao: PADRAO, agrovox: AGROVOX };
// O perfil vale para a marca principal (1). Outras marcas da mesma empresa (ex.: KC First Class ao lado da AgroVox)
// são de outro ramo: usam o perfil neutro, a não ser que tenham o próprio ("perfil:<marca>").
export const perfil = (brandId = 1) => {
  const b = Number(brandId) || 1;
  const key = b === 1 ? getSetting('perfil', 'padrao') : getSetting(`perfil:${b}`, 'padrao');
  return PERFIS[key] || PADRAO;
};

// Tira do começo do nome as palavras do perfil (ex.: "Agro Sinal Maria" -> "Maria"). Mais longas primeiro.
export function semPrefixo(name) {
  const n = String(name || '').trim();
  const p = [...perfil().prefixosNome].sort((a, b) => b.length - a.length)
    .find((x) => n.toLowerCase().startsWith(`${x} `));
  return p ? n.slice(p.length).trim().replace(/^(PY|AR|BR)\s+/, '') : n;
}
