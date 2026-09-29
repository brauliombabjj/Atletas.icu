# Pulso — painel do atleta

Dashboard responsivo em português para visualizar atividades recentes, distância, tempo em movimento, elevação e volume de treino do atleta no Intervals.icu.

## Requisitos

- Node.js 20 ou superior (usa apenas módulos nativos; não é necessário instalar dependências).
- Uma chave de API do Intervals.icu com acesso aos dados do atleta.

## Configurar e executar

1. No Intervals.icu, abra **Settings** e localize **Developer Settings** para criar uma chave de API. Trate essa chave como uma senha.
2. Configure `INTERVALS_API_KEY` no ambiente do processo que iniciará o servidor. `.env.example` documenta os nomes das variáveis; o servidor não carrega arquivos `.env` automaticamente. Exemplo no PowerShell:

   ```powershell
   $env:INTERVALS_API_KEY = "sua-chave"
   $env:INTERVALS_ATHLETE_ID = "BraulioMurtaBaiaoAlbino"
   npm start
   ```

   No macOS/Linux:

   ```sh
   export INTERVALS_API_KEY="sua-chave"
   export INTERVALS_ATHLETE_ID="BraulioMurtaBaiaoAlbino"
   npm start
   ```

3. Acesse [http://127.0.0.1:3000](http://127.0.0.1:3000). Opcionalmente, defina `PORT` e `HOST` para mudar a porta ou interface de rede.

## Login pela tela de conexão

Ao abrir o painel sem credenciais configuradas no ambiente, aparece a tela **Conectar ao Intervals.icu**, que pede:

- **Usuário**: o ID do atleta no Intervals.icu (por exemplo `i12345`);
- **Senha**: a chave de API criada em **Settings › Developer Settings**.

O servidor valida os dados no Intervals.icu antes de liberar o painel. As credenciais ficam somente na memória do servidor, associadas a um cookie `HttpOnly` (`SameSite=Strict`, 8 horas). O botão **Desconectar**, no rodapé do menu lateral, encerra a sessão e volta a pedir usuário e senha. Reiniciar o servidor também encerra as sessões.

`INTERVALS_API_KEY` continua funcionando como alternativa: se estiver definida e não houver sessão de login, o painel usa essa chave sem pedir credenciais. Para sempre ver a tela de login, deixe a variável sem valor.

## API e segurança

O backend consulta `GET https://intervals.icu/api/v1/athlete/{id}/activities`, com intervalo ISO-8601 e limite de 100 atividades. A chave (informada na tela ou configurada no ambiente) é enviada somente do servidor para o Intervals.icu por HTTP Basic Auth, usando o usuário `API_KEY` e a chave como senha. Ela não é incluída na resposta ao navegador nem registrada nos logs da aplicação. Falhas de conexão, autenticação, limite ou formato são apresentadas com mensagens claras sem repassar respostas privadas do provedor.

O identificador padrão é o slug informado (`BraulioMurtaBaiaoAlbino`); `INTERVALS_ATHLETE_ID` permite ajustá-lo. Guarde a chave apenas no ambiente do servidor e nunca a publique em código cliente ou repositório.

Documentação oficial consultada:

- [Documentação OpenAPI do Intervals.icu](https://intervals.icu/api/v1/docs) — lista de atividades, parâmetros `oldest`, `newest` e `limit`.
- [Acesso à API do Intervals.icu](https://forum.intervals.icu/t/api-access-to-intervals-icu/609) — criação da chave, HTTP Basic Auth (`API_KEY` como usuário) e limites.

## Desenvolvimento e verificações

```sh
npm run dev
npm test
```
