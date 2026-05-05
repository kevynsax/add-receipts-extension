# Receipt Transfer Helper

Chrome extension to import bank transfer receipts into the TRKBIT deposit page.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `/Users/kevynklava/projects/receipt-transfer-helper`.
5. Open `https://otc.trkbit.co/bk/clientes/depositos`.
6. Click the extension icon, or the blue **Receipts** button in the bottom-right corner.

## Qwen endpoint

The extension sends one receipt image at a time to:

`https://qwenvl.kevyn.com.br/v1/chat/completions`

It expects an OpenAI-compatible chat completions response. If your deployment uses a different API path, edit `QWEN_CHAT_COMPLETIONS_URL` in `content.js`.

Model used:

`Qwen/Qwen2.5-VL-7B-Instruct-AWQ`

Expected extracted JSON:

```json
{
  "bank": "B91",
  "beneficiary": "Cross Intermediação LTDA",
  "payer_name": "ISTORE ELETRONICOS E ASSISTENCIA LTDA",
  "payer_document": "22.333.930/0001-08",
  "amount": "13030.00",
  "date": "28/04/2026",
  "time": "14:10",
  "transaction_id": "E337..."
}
```

## Flow

- Drop receipt images or PDFs into the panel.
- After upload, choose the deposit date that will be sent for every receipt in that batch.
- After choosing the date, the review overlay opens automatically.
- PDFs are rendered locally as an image from page 1 only, then Qwen processes receipts one by one.
- Review/edit each extracted receipt in the overlay.
- The top thumbnail strip shows each receipt page; click a thumbnail to navigate between extracted receipts.
- Click **Fill** to insert the deposit directly through `https://otc.trkbit.co/api/operation/deposit/insert`.
- If inserting takes longer than 1 second, the overlay hides and the floating button shows session progress.
- Click the floating button anytime to reopen and continue.
- Click **Abort** to cancel the active Qwen request and clean the extension state.

## Current assumptions

- Bank defaults to `Creditag`, matching the deposit list screenshot, because the receipt bank may be the sender/source institution.
- Client defaults to `JukaCross`, matching the page screenshot.
- API insert uses `idAsset: 3`, `idCompany: 1`, `type: TED`, `status: AWAITING`, `idBank: "10"`, and `idUser: "39"`.
- The TRKBIT bearer token is read from the logged-in page storage; it is not hardcoded in the extension.
- Depositor is filled from `payer_name`.
- Value is filled from `amount`.
- The API `date` is the manually selected batch date, not the extracted receipt date.
