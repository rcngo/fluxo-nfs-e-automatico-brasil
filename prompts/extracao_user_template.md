<!-- Montado no n8n (nó Code) a cada chamada. Os {{ }} são substituídos. -->
<contexto>
data_hoje: {{data_hoje}}
canal: {{canal}}
prestador: {{prestador_razao_social}} (CNPJ {{prestador_cnpj}})
servicos_cadastrados:
{{#servicos}}
- id: {{id}} | apelido: {{apelido}} | descricao: {{descricao_padrao}}
{{/servicos}}
</contexto>

<dados_ja_coletados>
{{dados_json_ou_vazio}}
</dados_ja_coletados>

<conversa>
{{#mensagens}}
<mensagem direcao="{{direcao}}" data="{{criado_em}}">
{{conteudo}}
</mensagem>
{{/mensagens}}
</conversa>
