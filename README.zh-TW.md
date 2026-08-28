[English](README.md) · **繁體中文**

# DENBA 進銷存
<img width="2360" height="1640" alt="IMG_0563" src="https://github.com/user-attachments/assets/87725227-007c-4037-9d5a-b3b7e0d6a6ae" />

<img width="2360" height="1640" alt="IMG_0564" src="https://github.com/user-attachments/assets/fc778c29-99c0-4af6-a6cb-aceb271373c7" />

專為販售 **DENBA** 電場設備之小型儀器商打造、以 iPad 為優先考量的 PWA — 追蹤進貨、銷售、試用、即時庫存以及每月損益（P&L）。於 2026 年 7 月取代了含有大量公式的 Excel 活頁簿（進銷存 xlsx）。

單一檔案 **Flask + SQLite + waitress** 後端、vanilla-JS PWA 前端，**完全無需建置步驟**。可在位於 Cloudflare Tunnel 後方的 Raspberry Pi 上順暢運作。

## 功能

- **進貨** — 登記進貨：日期、一個或多個型號區塊（各包含獨立數量、金額，以及每台機器的獨立貨號 — 混合型號的發票在單次不可分割的儲存中會依型號拆分為每種一筆紀錄）、一般庫存／試用機切換開關，以及自動產生貨號功能；編輯彈出視窗會列出該筆進貨的所有機台，並支援原地編輯貨號（不可分割、防對調出錯、同步至銷售紀錄），且舊版僅有帳本紀錄的資料列（從 Excel 匯入且未連結機台實體者）支援編輯數量，並可一鍵拆單為各型號獨立的資料列
- **銷售** — 依貨號挑選在庫機台（自動帶入成本）、輸入總售價（自動平均分配至各機台），可選填刷卡手續費／保證書編號；儲存前即時預覽毛利；可在銷售當下輸入／更正實際序號。分為兩大類別：**一般銷售**，或**居間特許**（業務仲介成交之交易），後者分別追蹤保證金與佣金，自動分攤政府扣繳（預扣稅款 10% + 二代健保補充保費 2.11%）並提供一鍵「結清」狀態切換；**特許人應付對帳**面板會加總各特許人在所有未結清交易中的應付餘額，並支援「全部結清」批次操作；多機台銷售共用一個 `group_id` 且運作如同單一筆交易 — 單一卡片展示、群組層級售價／成本分配、整批結清、不可分割的刪除；每月特許金流表格（保證金收取／退還／淨支出）與月報並列顯示，並可獨立匯出為專屬 Excel 工作表。**特許領機**（寄售）記錄特許人在成交前預繳保證金所提領之機台 — 機台在庫存中顯示為特許機，收取的保證金計入特許金流，且可一鍵「售出」轉為預先填妥資料的居間特許銷售；銷售類別亦可在事後重新切換（供此功能推出前建立的舊資料使用）。每筆銷售皆可選填**其他費用**（金額 + 自訂名稱，例如：調貨／開發票）並列入月報支出；每筆交易的佣金比例皆可自訂（保證金%＋佣金%＝100%，下限為 12.11%，因預扣項目需由佣金扣除），且保證金／佣金／預扣稅款／補充保費均會依售價自動填入並支援手動編輯
- **試用** — 位於單一篩選列下的四種檢視：**試用機台**（展示機本體）、**租借中**、**預約**、**已歸還**。機台的*來源*與其出借方式相互獨立：自有機（購買取得）或總部月租（向總部按月租借）。試用機台將總部月租排在自有機之上，並依到期日排序，使逾期項目排在最前；總部卡片顯示標價／月租／到期（皆為選填），而非不屬於我方的成本，並可透過「已還總部」退還。任一來源的機台皆可透過三種方式出借 — 七天租、月租或特許租用（天數由特許決定）— 並附有剩餘天數標籤、「歸還」按鈕，且會依類別自動填入結束日期。已歸還會標註每筆紀錄的來源
- **庫存** — 依型號計算之**可售**機台*衍生*庫存：進貨量 − 銷售量。每台機器皆有專屬畫面可編輯貨號／成本／備註，並切換 在庫 ⇄ 試用機；已售與特許機在此處呈現唯讀狀態，因為這些狀態由銷售／特許領機流程所掌控。試用機台僅存在於試用中；總部月租機台絕不會出現在此，且 API 會拒絕販售此類機台
- **月報** — 每月營收／成本／毛利／毛利率表格 + 長條圖
- **報稅匯出** — 一鍵匯出**執行業務所得印領清冊**（`GET /api/tax-export.xlsx?year=YYYY`，或點選月報底部的年份選擇卡片）：原地套印會計師的空白 `tax_template.xlsx` 表格，使標楷體／邊框／列印版面配置與官方範本逐位元組完全相符，僅填入民國年份標題、特許人姓名，以及各月份已結清支付金額（佣金／扣繳稅額 10%／補充保費 2.11%／實領）。資料來源 = 依結清日歸納之已結清居間特許款項；身分證號／地址／扶養人數／前期佣金保留空白供負責人手動填寫。與主要匯出功能不同的是，此工作表保留了 SUM **公式**（供會計師在 Excel 中進一步編輯）
- **Excel 匯出** — 一鍵匯出包含 7 個工作表之活頁簿（月報／特許金流／特許人扣繳彙總／銷售明細／進貨明細／庫存／試用出租），輸出數值而非公式，確保 iPad QuickLook 預覽渲染正確。亦支援無外觀模式（headless）CLI 指令：`python server.py export out.xlsx [user_id]`
- 多使用者帳號與**完整的使用者資料隔離** — 每位使用者皆擁有專屬的紀錄、庫存、序號命名空間、報表以及 Excel 匯出
- **Passkey 登入** (WebAuthn) 支援密碼以外的驗證方式，可直接透過 Face ID / Touch ID 登入。伺服器端閒置 30 分鐘後連線階段失效，且 PWA 返回前景時會向伺服器重新確認 — 因 iOS 會將背景頁面保留於記憶體中，若無此檢查，已過期的連線階段在外觀上仍會顯示為已登入狀態
- **破壞性操作具備安全防護**：每次刪除皆會明確列出該筆紀錄的詳細資訊（客戶、型號、日期、金額）以及刪除後機台的後續處理狀態。機台可從專屬編輯畫面刪除，但僅限於無任何會計關聯指向該機台時（非已售、非特許持機、無銷售紀錄、無進貨來源）— 且必須手動重新輸入其貨號確認，因為此操作一旦執行即無法藉由重新輸入還原
- 管理員面板：建立／管理使用者（一般／管理員角色、升級／降級、重設密碼、刪除時自動建立資料快照）。帳號可指向另一位使用者的資料（`users.shares_with`），使第二個登入帳號在維持自身憑證的同時能檢視相同的紀錄
- 登入採用記憶體內速率限制：單一 IP 失敗 10 次或單一使用者名稱失敗 20 次後鎖定 15 分鐘，並採用恆定時間的密碼雜湊比對，避免透過計時攻擊區分使用者名稱錯誤或密碼錯誤
- 雙層備份機制：任何人皆可還原的單一使用者快照（僅限自身資料）+ 供管理員使用的全資料庫快照
- PWA 可安裝至 iPad 主畫面
- 在 iOS 上，可在任何貨號欄位中使用內建的**掃描文字 (Scan Text)** 功能對序號標籤進行 OCR 辨識

## 架構

```
static/           vanilla JS PWA (index.html, app.js, style.css, sw.js, manifest)
server.py         Flask app: auth, JSON API, xlsx export (also CLI: python server.py export out.xlsx)
tax_template.xlsx accountant's blank 執行業務所得印領清冊 form (no personal data); filled in place by 報稅匯出
denba.db          SQLite (created on first run; seeded from seed_data.json if present and DB empty)
deploy/           systemd unit, daily backup cron script, OneDrive pull script (Windows), env example,
                  one-off data migrations (run with a db path; --apply to commit, otherwise a dry-run
                  that executes and rolls back so the preview is exact)
```

資料表：`users`、`webauthn_credentials`（通行密鑰）、`purchases`、`units`（每台機器一筆資料 — 成本、`status` 與 `source` 儲存於此；`source='hq'` 之機台帶有總部租期的 `hq_start`／`hq_due`／`hq_rent` 且無 `purchase_id`）、`sales`（非正規化之型號／序號，包含居間特許之保證金／佣金／扣繳欄位）、`trials`（`rent_type` = 出借方式，`source` = 機台來源）、`consignments`（特許領機 — 特許在銷售前預繳保證金所持有的機台）。庫存是由 `units.status` 衍生計算得出 — 並無另外維護的庫存數量計數。

`rent_type` 與 `source` 是刻意分開的。這兩者過去曾是同一個欄位，導致僅從總部*持有*的機台被誤記為租借，在無人承租的情況下卻停留在租借中（`deploy/migrate_v37_hq.py` 釐清並修復了此段歷史資料）。

## 快速開始

```bash
python -m venv venv
venv/bin/pip install -r requirements.txt
cp deploy/denba.env.example denba.env   # set APP_USER / APP_PASSWORD / SECRET_KEY
                                        # (RP_ID / ORIGIN too, if you want passkey login)
set -a; . ./denba.env; set +a
python server.py                        # → http://localhost:2026
```

首次執行時，`APP_USER`／`APP_PASSWORD` 會成為初始管理員帳號；之後可在應用程式內管理使用者（⚙️ → 使用者管理）。

## 生產環境部署

部署於 Raspberry Pi 4 (Debian, aarch64) 的 `/opt/denba` 路徑下，由 systemd (`deploy/denba.service`) 執行，並透過 Cloudflare Tunnel (`http://localhost:2026`) 對外提供服務。每晚 cron 排程會建立保留 30 天輪替的 `.db` 快照**以及**最新的 xlsx；Windows 排程工作則會將兩者拉取至 OneDrive。詳細的維運手冊於本儲存庫之外私下維護。

## 注意事項

- `seed_data.json`（真實客戶／財務資料）刻意**不提交至版本控制** — 格式請參閱 `seed_data.example.json`。應用程式在沒有此檔案的情況下亦能正常運作（從空白資料開始）。
- `deploy/denba.env`（密鑰資訊）已被 git 忽略；請使用 `.example` 範本。
- 建議：在公開主機名稱前方加上 Cloudflare Access 作為第二道身分驗證層。
