@echo off
cd /d "%~dp0"
if not exist node_modules\imapflow (
  echo Instalando componentes - so na primeira vez, precisa de internet...
  call npm install --no-audit --no-fund
)
if not exist data mkdir data
start "" cmd /c "timeout /t 3 >NUL & start http://localhost:3000"
echo.
echo  Meu CRM rodando em http://localhost:3000
echo  Deixe esta janela aberta (pode minimizar). Para desligar o CRM, feche esta janela.
echo  O registro do que acontece fica em data\crm.log
echo.
rem A saida vai para o arquivo: assim um clique sem querer nesta janela nao congela o CRM.
node --env-file-if-exists=.env server\index.js >> data\crm.log 2>&1
echo O CRM parou. Veja data\crm.log
pause
