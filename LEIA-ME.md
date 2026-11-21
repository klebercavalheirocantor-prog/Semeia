# Meu CRM

CRM de vendas com funil, contatos, tarefas e caixa de conversas do WhatsApp, Instagram e Messenger. Roda no seu computador, os dados ficam com você.

## Ligar

Clique duas vezes em `iniciar.bat`. O navegador abre em http://localhost:3000.

- **Primeira vez:** o CRM pede para criar o administrador (você).
- **Deixe a janela preta aberta** enquanto usa. Fechou, o CRM desliga.
- Pelo terminal também funciona: `npm start`.

### A equipe em outros computadores

1. Copie `.env.example` para `.env` e troque `HOST=127.0.0.1` por `HOST=0.0.0.0`.
2. Reinicie. A janela mostra o endereço da rede (ex.: `http://192.168.0.10:3000`).
3. Em Configurações > Equipe, crie um usuário para cada pessoa.

O Windows pode perguntar se libera o Node.js na rede: libere só em **redes privadas**.

## Conectar o WhatsApp (API oficial da Meta)

Precisa ser feito por você, porque são as suas contas:

1. **Conta Meta Business verificada** em business.facebook.com.
2. Em **developers.facebook.com**, crie um app do tipo **Empresa** e adicione o produto **WhatsApp**.
3. Em WhatsApp > Configuração da API, adicione o número da empresa. Copie o **Phone number ID**. O número não pode estar ativo no app WhatsApp comum ao mesmo tempo.
4. No Gerenciador de Negócios, em Usuários do sistema, crie um usuário admin, dê acesso ao app e à conta do WhatsApp e gere um **token permanente** com `whatsapp_business_messaging` e `whatsapp_business_management`.
5. Em Configurações do app > Básico, copie a **Chave secreta do app (App Secret)**.
6. **Endereço público (HTTPS).** A Meta precisa alcançar o seu PC para entregar as mensagens:
   - o túnel gratuito da Cloudflare já está instalado. Para ligar: `cloudflared tunnel --url http://localhost:3000`
   - ele mostra um endereço `https://algo.trycloudflare.com`.
   - o primeiro acesso (criar administrador) só funciona no próprio PC, nunca pelo túnel.
7. No CRM, em **Configurações > Geral**: cole o endereço público e o App Secret e salve. Copie a **URL de retorno** e o **token de verificação** que aparecem ali.
8. No app da Meta, em WhatsApp > Configuração > Webhook: cole a URL de retorno e o token de verificação, clique em Verificar e assine o campo **messages**.
9. No CRM, em **Configurações > Canais > Conectar canal**: escolha WhatsApp, cole o Phone number ID e o token. Clique em **Testar**.

Pronto: mensagem que chega vira contato e lead na etapa "Novas conversas", e a resposta sai pelo cartão do lead ou pela tela Conversas.

> O endereço `trycloudflare.com` muda toda vez que o túnel reinicia, e aí é preciso atualizar no app da Meta. Para um endereço fixo, use um túnel nomeado da Cloudflare (com domínio próprio) ou hospede o CRM num servidor.

**Instagram e Messenger:** mesmo app, mesma URL de retorno. Adicione o produto Messenger (e Instagram), gere o token da Página e conecte em Canais. Para falar com clientes reais, a Meta exige a **análise do app** (App Review), que leva dias.

**Regra das 24 horas do WhatsApp:** você responde livremente até 24 h depois da última mensagem do cliente. Depois disso, ou para chamar quem nunca escreveu, só com **mensagem modelo** aprovada pela Meta:

1. No canal (Configurações > Canais > Editar), preencha o **WABA ID** (ID da conta do WhatsApp, na mesma tela da API).
2. Em **Configurações > Modelos do WhatsApp**, escreva o modelo (ex.: `Olá {{1}}, tudo bem? Ainda tem interesse no orçamento?`) e envie para aprovação. Costuma levar minutos.
3. No contato ou no lead, clique em **Chamar no WhatsApp**, escolha o modelo e envie. A conversa e o lead são criados sozinhos.

A Meta cobra por conversa iniciada por modelo (veja os preços no Gerenciador do WhatsApp).

## Painel

Em **Painel**: leads novos, valor em aberto, taxa de conversão, tempo médio para fechar, receita ganha e perdida, ticket médio, evolução por dia, leads por etapa e por origem, contatos por etiqueta e resultado das campanhas. Escolha o período (7, 30, 90 dias ou 12 meses).

## Campanhas (WhatsApp e e-mail)

Em **Campanhas > Nova campanha**:

1. **Público:** marque as etiquetas (ex.: Pecuária MS). Ficam de fora sozinhos: quem pediu para sair, quem não tem celular/e-mail e quem recebeu campanha nos últimos 7 dias.
2. **Mensagem:**
   - WhatsApp: só **modelo aprovado pela Meta** (crie em Ajustes > Modelos do WhatsApp, categoria Marketing). Use `{{primeiro_nome}}` na variável.
   - E-mail: assunto e texto com `{{primeiro_nome}}`. Configure antes em **Ajustes > E-mail** (conta na Resend, domínio verificado e chave de API).
3. **Ritmo:** intervalo entre envios, horário (ex.: 8h às 20h) e limite por dia. O CRM envia um por um, sozinho, enquanto estiver ligado.

Quem **responde** vira lead em "Novas conversas" e a campanha conta a resposta (até 72 h). Quem responde **SAIR / PARAR / STOP** (ou clica no link do e-mail) não recebe mais campanhas; o atendimento continua normal. A campanha **pausa sozinha** se o modelo deixar de estar aprovado, o canal desligar ou 5 envios seguidos falharem.

> Disparo para lista fria tem risco: no WhatsApp, muita gente bloqueando ou denunciando baixa a qualidade do número e a Meta limita os envios. Comece com 100 a 200 por dia, para quem conhece a sua empresa, e acompanhe a qualidade no Gerenciador do WhatsApp.

## Importar seus contatos

Em **Contatos > Importar**, envie o arquivo exportado do celular (`.vcf`), do Google Contatos (`.csv`) ou do Excel (`.csv` com colunas nome, telefone, email, empresa). Quem já existe não é duplicado. Nenhuma mensagem é enviada.

> O histórico de conversas antigas do WhatsApp não vem: a API da Meta só entrega mensagens a partir do momento em que o número é conectado.

## Backup

Todo dia o CRM salva uma cópia em `data/backups/` e guarda as últimas 14. **Copie essa pasta para fora do PC** (pendrive, Google Drive) de vez em quando: se o disco morrer, os backups morrem junto.

Para restaurar: desligue o CRM, troque `data/crm.db` por um backup renomeado para `crm.db` e ligue de novo.

## Esqueceu a senha

- Outra pessoa admin troca em Configurações > Equipe > Editar.
- Ou, no terminal, dentro da pasta: `npm run senha -- seu@email.com NovaSenha123`

## O que tem hoje (fase 1)

Funil em colunas com arrastar e soltar, vários funis, ganho e perdido com motivo, cartão do lead com histórico, notas, tarefas, contatos e empresas, tags, campos personalizados, caixa de conversas (WhatsApp, Instagram, Messenger) com atualização ao vivo, triagem de conversas novas, permissões por função, desativar usuário passando os leads, backup diário.

## O que vem depois

- **Fase 2 (parte feita):** painel, campanhas de WhatsApp e e-mail, etiquetas na importação. Falta: automações por etapa, formulário para o site.
- **Fase 3:** robô de conversa, sequências (cadências), agendamentos.
- **Fase 4:** atendente com IA.

A lista completa está em `replica/features.csv`, e o plano em `replica/architecture.md`.

## Testes

`npm test` roda os testes automáticos (duplicidade de contato, webhook, permissões, envio).

## Fluxos (robô de respostas)

Menu **Fluxos**. Desenhe o que acontece quando o cliente responde: arraste os blocos pelo título e puxe a bolinha de uma saída até o próximo bloco.

- **Gatilhos:** resposta a uma campanha (qualquer uma ou uma específica), primeira mensagem de alguém novo, ou lead entrando numa etapa.
- **Blocos:** Mensagem (até 3 botões), Pergunta (espera a resposta; cada botão vira uma saída, mais "outra resposta" e "sem resposta"), Esperar, IA responde, IA entende a intenção, Mover etapa, Etiqueta, Passar para humano, Fim.
- **Passar para humano:** cria a tarefa "Responder fulano", deixa a conversa como não lida e o robô para.
- **O robô para sozinho** quando um atendente responde pela caixa de entrada, quando o cliente manda SAIR, ou quando o cliente escreve durante uma espera.
- **Simular:** testa o desenho sem enviar nada (os blocos de IA chamam a IA de verdade).
- **Execuções:** quem está em qual passo; dá para parar uma conversa.
- Vem um fluxo pronto, **desligado**: "Resposta à campanha: sinais GPS" (pergunta o modelo da antena e do monitor → IA responde → humano).

**Assistente de IA** (Ajustes › Assistente de IA): chave da Anthropic (console.anthropic.com), modelo e base de conhecimento. A IA só responde com o que estiver na base; preço que não estiver lá ela não inventa e passa para você.

**Limite do WhatsApp:** texto livre e botões só valem até 24 h depois da última mensagem do cliente. Por isso os prazos de "sem resposta" vão até 23 h.

## Campanha com imagem

Modelos com imagem no topo (a arte) são criados no WhatsApp Manager da Meta e sincronizados em Ajustes › Modelos. Na campanha, escolha o modelo e envie a imagem (JPG/PNG até 5 MB). Ela sobe uma vez para a Meta e vai para todos.

## Ritmo das campanhas de WhatsApp (padrão)

Mesmo ritmo do WA Web Plus: intervalo sorteado de 15 a 30 s, das 6h às 22h (horário de Brasília), em lotes de 310 a 332 mensagens (tamanho sorteado a cada lote) com 2 h de pausa entre lotes. Dá cerca de 1.280 mensagens por dia. Tudo editável em Campanha › 4. Ritmo e horário.

## WhatsApp Web (QR code) — como o WA Web Plus

Ajustes › Canais › **Conectar pelo QR code**. No celular do número: WhatsApp › Aparelhos conectados › Conectar aparelho. A sessão fica salva em `data/whatsapp-web` (só lê o QR uma vez).

- Campanha nova de WhatsApp sai por ele automaticamente: **texto livre** (com `{{primeiro_nome}}`) e a arte opcional, sem modelo da Meta e sem custo por mensagem.
- Número sem WhatsApp é pulado ("número sem WhatsApp") e não conta no lote.
- Respostas chegam no CRM e rodam os fluxos. O que você manda pelo celular nas conversas do CRM aparece lá e faz o robô sair da conversa (conversas pessoais ficam de fora).
- Se cair a conexão, a campanha pausa e ninguém se perde na fila: reconecte e clique em Retomar.
- Na primeira vez, o `iniciar.bat` instala o componente (precisa de internet; baixa um Chrome só para o CRM, alguns minutos).
- Não é a API oficial: o que protege o número é o ritmo. Não dispare pelo WA Web Plus e pelo CRM ao mesmo tempo. O PC precisa ficar ligado com o CRM aberto.

## Leads dos anúncios do Facebook/Instagram (clique para WhatsApp)

Quem clica no anúncio e manda mensagem para o número conectado entra sozinho no CRM:

- vira contato e lead em "Novas conversas", com origem **Anúncio Facebook/Instagram** (aparece no Painel, em "Leads por origem");
- ganha a etiqueta **Veio do anúncio**;
- o lead recebe uma nota com o anúncio: onde clicou (Facebook ou Instagram), título, texto, link e ID do anúncio.

**Robô:** em Fluxos, ligue **"Veio do anúncio: tabela de preços"** (gatilho "Quando chegar pelo anúncio"). Ele pergunta o modelo da antena e do monitor, manda a tabela certa e passa para você. Desligado, o lead entra do mesmo jeito, só sem resposta automática.

**CRM fechado:** ao abrir de novo, o CRM puxa quem escreveu enquanto estava fechado (até 24 h para trás) e roda o mesmo processo.

> O anúncio precisa apontar para o **mesmo número** que está conectado no CRM pelo QR code.

## Painel › Resultado (lucro e ROI)

Em **Painel**, aba **Resultado (lucro e ROI)**: investido, vendido, lucro, ROI (número e %) e ROAS, do jeito do relatório de escala; pizzas e barras por canal, vendido por mês, quem mais comprou e todas as vendas.

- **Venda:** mova o lead para **Venda fechada** com o valor e preencha no cartão **Custo do produto** (e **Taxa de pagamento**, se houver). **Canal da venda** é opcional: sem ele, lead do anúncio conta como Facebook e o resto como disparo.
- **Investimento:** vem de `data/investimento.json`, que uma tarefa agendada do Claude atualiza com o gasto das campanhas do Facebook. O CRM só lê; nenhum token do Facebook fica aqui. EUA (pausada) e disparo ficam com o valor fixo do arquivo.
- Venda sem custo aparece com aviso, porque o lucro dela fica maior que o real.
