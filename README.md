# h173k Solana RPC Proxy – Cloudflare Pages

Proxy dla Cloudflare Pages Functions, który obsługuje zapytania Solana RPC
wyłącznie z dozwolonych domen i filtruje metody do bezpiecznego podzbioru.

---

## Struktura plików

```
your-repo/
├── functions/
│   └── rpc.js          ← ten plik
├── public/             ← opcjonalny folder ze statyczną stroną (może być pusty)
│   └── index.html
└── wrangler.toml
```

---

## Endpointy

| URL                                          | Metoda |
|----------------------------------------------|--------|
| `https://<twoja-domena>.pages.dev/rpc`       | POST   |

---

## Dozwolone origins

- `https://h173k-wallet.pages.dev`
- `https://h173k-burn-chat.pages.dev`

Zapytania z innych domen zwracają **HTTP 403**.

---

## Dozwolone metody RPC

**Otwarte** (nie wymagają filtra adresu):
`getSlot`, `getRecentBlockhash`, `getLatestBlockhash`, `getFeeForMessage`,
`getBlockTime`, `getHealth`, `getVersion`

**Bramkowane** (tylko znane metody Solany):
`getAccountInfo`, `getBalance`, `getTransaction`, `getTokenAccountsByOwner`,
`getSignaturesForAddress`, `getMultipleAccounts`, `sendTransaction`,
`simulateTransaction`, `getTokenAccountBalance`

Wszystkie inne metody zwracają błąd `-32601 Method not allowed`.

---

## Deployment

### 1. Utwórz repozytorium i wgraj pliki

```bash
git init h173k-rpc
cd h173k-rpc
mkdir -p functions public
# skopiuj rpc.js do functions/
# skopiuj wrangler.toml do katalogu głównego
echo '<html><body>h173k RPC</body></html>' > public/index.html
git add . && git commit -m "init rpc proxy"
git remote add origin https://github.com/<twoj-user>/h173k-rpc.git
git push -u origin main
```

### 2. Połącz z Cloudflare Pages

1. Cloudflare Dashboard → **Pages** → **Create a project** → **Connect to Git**
2. Wybierz repozytorium `h173k-rpc`
3. Build settings:
   - **Framework preset**: `None`
   - **Build command**: *(puste)*
   - **Build output directory**: `public`
4. Kliknij **Save and Deploy**

### 3. Ustaw zmienne środowiskowe (Secrets)

Pages → twój projekt → **Settings** → **Environment variables** → **Add variable**

| Nazwa           | Wartość                           | Typ     |
|-----------------|-----------------------------------|---------|
| `SOLANA_RPC_URL`| `https://your-private-rpc.com`    | Secret  |
| `RPC_SECRET`    | dowolny losowy string (opcjonalne)| Secret  |

> Jeśli `RPC_SECRET` jest ustawiony, klienci muszą wysyłać nagłówek:
> `Authorization: Bearer <twoj-secret>`

### 4. Testowanie

```bash
curl -X POST https://<twoja-domena>.pages.dev/rpc \
  -H "Content-Type: application/json" \
  -H "Origin: https://h173k-wallet.pages.dev" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "getLatestBlockhash",
    "params": []
  }'
```

---

## Użycie po stronie klienta

```javascript
const RPC_URL = "https://<twoja-domena>.pages.dev/rpc";

async function getSolanaBalance(walletAddress) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBalance",
      params: [walletAddress],
    }),
  });
  const { result } = await res.json();
  return result.value / 1e9; // lamports → SOL
}

async function getH173kTokenAccounts(walletAddress) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "getTokenAccountsByOwner",
      params: [
        walletAddress,
        { mint: "173AvoJNQoWsaR1wdYTMNLUqZc1b7d4SzB2ZZRZVyz3" },
        { encoding: "jsonParsed" },
      ],
    }),
  });
  return (await res.json()).result.value;
}
```

---

## Bezpieczeństwo

- CORS zablokowany dla wszystkich domen poza dozwolonymi
- Whitelist metod – nieznane metody są odrzucane
- Opcjonalny Bearer token dla dodatkowej warstwy autoryzacji
- Klucz RPC (Alchemy, QuickNode, Helius itp.) nigdy nie jest widoczny dla klienta
