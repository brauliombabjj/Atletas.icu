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

Sem a chave, o painel mostra uma mensagem de configuração e continua servindo a página. Não há dados falsos de demonstração.

## API e segurança

O backend consulta `GET https://intervals.icu/api/v1/athlete/{id}/activities`, com intervalo ISO-8601 e limite de 100 atividades. A chave é enviada somente do servidor para o Intervals.icu por HTTP Basic Auth, usando o usuário `API_KEY` e a chave como senha. Ela não é incluída na resposta ao navegador nem registrada nos logs da aplicação. Falhas de conexão, autenticação, limite ou formato são apresentadas com mensagens claras sem repassar respostas privadas do provedor.

O identificador padrão é o slug informado (`BraulioMurtaBaiaoAlbino`); `INTERVALS_ATHLETE_ID` permite ajustá-lo. Guarde a chave apenas no ambiente do servidor e nunca a publique em código cliente ou repositório.

Documentação oficial consultada:

- [Documentação OpenAPI do Intervals.icu](https://intervals.icu/api/v1/docs) — lista de atividades, parâmetros `oldest`, `newest` e `limit`.
- [Acesso à API do Intervals.icu](https://forum.intervals.icu/t/api-access-to-intervals-icu/609) — criação da chave, HTTP Basic Auth (`API_KEY` como usuário) e limites.

## Desenvolvimento e verificações

```sh
npm run dev
npm test
```
