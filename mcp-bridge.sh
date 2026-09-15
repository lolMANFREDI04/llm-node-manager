#!/bin/sh

URL_BASE="http://127.0.0.1:8080/v1/chat/completions"
PROMPT="$1"

if [ -z "$PROMPT" ]; then
  echo "Uso: ./mcp-bridge.sh \"La tua richiesta\""
  exit 1
fi

echo "[1] Analisi della richiesta (Router AI)..."

# La "Forzatura del completamento": chiediamo direttamente il Command alla fine del prompt utente
ROUTER_PAYLOAD=$(jq -n \
  --arg prompt "$PROMPT" \
  '{
    temperature: 0.0,
    messages: [
      {
        "role": "system",
        "content": "You are a strict command extractor. DO NOT answer the prompt. ONLY output a command.\n- URL present? -> FETCH <url>\n- Asking for info/search? -> SEARCH <keywords>\n- General chat? -> CHAT"
      },
      {
        "role": "user",
        "content": ("Text: " + $prompt + "\n\nOutput only the command:")
      }
    ]
  }')

RESP=$(curl -s "$URL_BASE" -H "Content-Type: application/json" -d "$ROUTER_PAYLOAD")
RAW_CONTENT=$(echo "$RESP" | jq -r '.choices[0].message.content // empty' | tr -d '`' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

if echo "$RAW_CONTENT" | grep -qi "FETCH"; then
  TOOL_URL=$(echo "$RAW_CONTENT" | sed -E 's/.*FETCH //I' | grep -o 'https\?://[^ "]*')
  echo "[2] Tool FETCH attivato su: $TOOL_URL"
  FETCHED_DATA=$(curl -s -L "$TOOL_URL")
  CLEAN_DATA=$(echo "$FETCHED_DATA" | jq -r 'if type=="object" then to_entries|map("\(.key): \(.value)")|join(", ") else . end' 2>/dev/null || echo "$FETCHED_DATA" | head -c 1000)

elif echo "$RAW_CONTENT" | grep -qi "SEARCH"; then
  # Estrae tutto quello che c'è dopo SEARCH
  QUERY=$(echo "$RAW_CONTENT" | sed -E 's/.*SEARCH //I')
  echo "[2] Tool SEARCH attivato per: $QUERY"
  
  ENCODED_QUERY=$(echo "$QUERY" | jq -sRr @uri)
  SEARCH_URL="https://it.wikipedia.org/w/api.php?action=query&list=search&srsearch=${ENCODED_QUERY}&utf8=&format=json"
  FETCHED_DATA=$(curl -s "$SEARCH_URL")
  CLEAN_DATA=$(echo "$FETCHED_DATA" | jq -r '.query.search | .[0:2] | map("Titolo: \(.title) - Contenuto: \(.snippet)") | join("\n")' | sed 's/<[^>]*>//g')
  
  if [ -z "$CLEAN_DATA" ] || [ "$CLEAN_DATA" = "null" ]; then
     CLEAN_DATA="Nessun risultato trovato sul web."
  fi
else
  echo "[2] Nessun tool richiesto (Modalità CHAT). Generazione risposta..."
  FINAL_PAYLOAD=$(jq -n \
    --arg prompt "$PROMPT" \
    '{
      temperature: 0.6,
      messages: [
        { "role": "system", "content": "Sei un assistente utile e conversazionale. Rispondi in italiano." },
        { "role": "user", "content": $prompt }
      ]
    }')
  curl -s "$URL_BASE" -H "Content-Type: application/json" -d "$FINAL_PAYLOAD" | jq -r '.choices[0].message.content // "Errore di risposta"'
  exit 0
fi

echo "[3] Dati recuperati. Generazione sintesi..."

FINAL_PAYLOAD=$(jq -n \
  --arg data "$CLEAN_DATA" \
  --arg prompt "$PROMPT" \
  '{
    temperature: 0.1,
    messages: [
      {
        "role": "system",
        "content": "Sei un assistente. Usa SOLO le informazioni fornite per rispondere. Sintetizza in modo naturale in italiano."
      },
      {
        "role": "user",
        "content": ("Informazioni recuperate dal web:\n" + $data + "\n\nDomanda dell utente: " + $prompt)
      }
    ]
  }')

curl -s "$URL_BASE" -H "Content-Type: application/json" -d "$FINAL_PAYLOAD" | jq -r '.choices[0].message.content // "Errore di risposta"'
