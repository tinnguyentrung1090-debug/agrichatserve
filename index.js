
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import MiniSearch from "minisearch";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import mammoth from "mammoth";
import XLSX from "xlsx";
import Database from "better-sqlite3";
import QRCode from "qrcode";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json({limit:"12mb"}));

const DATA_DIR = path.resolve("./data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/** DB */
const db = new Database("./agrichat.db");
db.exec(`
CREATE TABLE IF NOT EXISTS leads(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  name TEXT, phone TEXT, need_type TEXT, province TEXT, amount REAL, note TEXT, source_channel TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT, source_path TEXT, doc_type TEXT, page_or_ref TEXT, text_chunk TEXT
);
`);

let mini = new MiniSearch({
  fields: ["text_chunk", "title"],
  storeFields: ["title","source_path","page_or_ref","text_chunk"]
});

function splitChunks(text, size = 1200) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

async function ingestFolder() {
  const files = fs.readdirSync(DATA_DIR);
  let docs = [];
  for (const f of files) {
    const p = path.join(DATA_DIR, f);
    const ext = f.toLowerCase().split(".").pop();
    try {
      if (ext === "pdf") {
        const buf = fs.readFileSync(p);
        const out = await pdf(buf);
        const pages = out.text.split(/\f/g);
        pages.forEach((t, i)=> {
          const chunks = splitChunks((t||"").trim());
          chunks.forEach((ct, j)=> {
            const row = db.prepare("INSERT INTO docs(title,source_path,doc_type,page_or_ref,text_chunk) VALUES (?,?,?,?,?)")
              .run(f, p, "pdf", `${i+1}.${j+1}`, ct);
            docs.push({ id: row.lastInsertRowid, title: f, source_path:p, page_or_ref:`${i+1}.${j+1}`, text_chunk: ct });
          });
        });
      } else if (ext === "docx") {
        const buf = fs.readFileSync(p);
        const out = await mammoth.extractRawText({buffer: buf});
        const blocks = out.value.split(/\n{2,}/);
        blocks.forEach((t,i)=>{
          const chunks = splitChunks((t||"").trim());
          chunks.forEach((ct,j)=>{
            const row = db.prepare("INSERT INTO docs(title,source_path,doc_type,page_or_ref,text_chunk) VALUES (?,?,?,?,?)")
              .run(f, p, "docx", `block-${i+1}.${j+1}`, ct);
            docs.push({ id: row.lastInsertRowid, title:f, source_path:p, page_or_ref:`block-${i+1}.${j+1}`, text_chunk:ct});
          });
        });
      } else if (ext === "xlsx" || ext === "xls") {
        const wb = XLSX.readFile(p);
        wb.SheetNames.forEach(sn=>{
          const data = XLSX.utils.sheet_to_csv(wb.Sheets[sn], {FS:"\t"});
          const chunks = splitChunks(data.trim());
          chunks.forEach((ct,j)=>{
            const row = db.prepare("INSERT INTO docs(title,source_path,doc_type,page_or_ref,text_chunk) VALUES (?,?,?,?,?)")
              .run(f, p, "xlsx", `${sn}.${j+1}`, ct);
            docs.push({ id: row.lastInsertRowid, title:f, source_path:p, page_or_ref:`${sn}.${j+1}`, text_chunk:ct });
          });
        });
      } else if (ext === "txt" || ext === "csv") {
        const t = fs.readFileSync(p,"utf8");
        const chunks = splitChunks(t.trim());
        chunks.forEach((ct,j)=>{
          const row = db.prepare("INSERT INTO docs(title,source_path,doc_type,page_or_ref,text_chunk) VALUES (?,?,?,?,?)")
            .run(f, p, ext, `all.${j+1}`, ct);
          docs.push({ id: row.lastInsertRowid, title:f, source_path:p, page_or_ref:`all.${j+1}`, text_chunk:ct });
        });
      }
    } catch(e) { console.error("Ingest error", f, e.message); }
  }
  mini = new MiniSearch({ fields:["text_chunk","title"], storeFields:["title","source_path","page_or_ref","text_chunk"] });
  mini.addAll(docs);
  console.log("Ingested", docs.length, "chunks");
}
await ingestFolder();

function intentOf(q) {
  const s = (q||"").toLowerCase();
  if (/(tín dụng|vay|khoản vay|thế chấp|hạn mức)/.test(s)) return "loan";
  if (/(tiền gửi|sổ tiết kiệm|kỳ hạn|lãi suất)/.test(s)) return "deposit";
  if (/(thẻ|atm|giao dịch thẻ|visa|master)/.test(s)) return "card";
  if (/(tra soát|khiếu nại|nhầm|sai|mất tiền)/.test(s)) return "dispute";
  if (/(lãi suất|rate|interest)/.test(s)) return "rate";
  return "general";
}

function templateAnswer(intent, hits) {
  const head = {
    loan: "Tư vấn Tín dụng:",
    deposit: "Tư vấn Tiền gửi:",
    card: "Tư vấn Thẻ:",
    dispute: "Tra soát/Khiếu nại:",
    rate: "Thông tin Lãi suất:",
    general: "Thông tin bạn quan tâm:"
  }[intent];

  const top = hits.slice(0,2).map(h=> `• ${h.title} – trích đoạn [${h.page_or_ref}]:\n${(h.text_chunk||"").slice(0,360)}…`).join("\n\n");
  const cta = "\n\n👉 Để được tư vấn chi tiết, vui lòng để lại Họ tên & SĐT (tôi sẽ gọi lại trong giờ làm việc).";
  return `${head}\n${top || "Hiện chưa tìm thấy đoạn phù hợp, bạn mô tả rõ hơn giúp tôi nhé."}${cta}`;
}

app.post("/ask", async (req,res)=>{
  const { question } = req.body || {};
  const intent = intentOf(question||"");
  const results = question ? mini.search(question, { fuzzy: 0.2, prefix: true }) : [];
  const hits = results.map(r => ({
    title: r.title, source_path: r.source_path, page_or_ref: r.page_or_ref, text_chunk: r.text_chunk
  }));
  const answer = templateAnswer(intent, hits);
  res.json({ answer, intent, citations: hits.slice(0,2) });
});

app.post("/lead", (req,res)=>{
  const { name, phone, need_type, province, amount, note, source_channel } = req.body || {};
  const st = db.prepare("INSERT INTO leads(name,phone,need_type,province,amount,note,source_channel,status) VALUES (?,?,?,?,?,?,?,?)");
  st.run(name||"", phone||"", need_type||"", province||"", Number(amount||0), note||"", source_channel||"web", "new");
  res.json({ ok:true });
});

app.get("/qr", async (req,res)=>{
  const url = req.query.url || "https://your-vercel-app.vercel.app";
  const png = await QRCode.toBuffer(String(url), { width: 400 });
  res.setHeader("Content-Type","image/png");
  res.send(png);
});

app.get("/", (req,res)=>{
  res.send("Agrichat server is running. POST /ask, /lead. GET /qr?url=...");
});

const port = process.env.PORT || 3001;
app.listen(port, ()=> console.log("Server listening on", port));
