// server.js
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { ok, bad } from "./utils/respond-express.js";
import {
  sanitizeSub,
  isValidEmailLocal,
  isValidDestinationEmail,
} from "./utils/validators.js";
import { checkNim } from "./utils/students.js";
import { getDb } from "./utils/db.js";
import {
  createCNAME,
  createEmailRoute,
  getRootDomain,
  deleteDNSRecord,
  deleteEmailRoute,
} from "./utils/cf.js";
import {
  enforceNimAuthOrResponse,
  requireAdmin,
} from "./utils/nim_auth.js";

const app = express();

// --- Hardening & middleware dasar ---
app.use(helmet());
app.use(
  cors({
    // sesuaikan origin bila frontend beda domain
    origin: true,
    credentials: false,
  })
);
app.use(express.json());
app.use(morgan("tiny"));

const ROOT = getRootDomain();

// ====== Health ======
app.get("/api/health", (req, res) =>
  ok(res, { ok: true, service: "ikmi-backend-heroku" })
);

// ====== Validate NIM ======
app.post("/api/validate-nim", async (req, res) => {
  try {
    const { nim } = req.body || {};
    if (!nim) return bad(res, "nim is required");
    const v = checkNim(nim);
    if (!v.valid) return ok(res, { valid: false, nim });

    const db = await getDb();
    const subs = await db
      .collection("subdomains")
      .countDocuments({ nim: v.nim });
    const emails = await db
      .collection("emails")
      .countDocuments({ nim: v.nim });

    return ok(res, {
      valid: true,
      nim: v.nim,
      nama: v.nama,
      usage: { subdomains: subs, emails },
    });
  } catch (e) {
    return bad(res, e.message, 500);
  }
});

// ====== Create Subdomain ======
app.post("/api/create-subdomain", async (req, res) => {
  try {
    const { nim, subdomain } = req.body || {};
    if (!nim || !subdomain) return bad(res, "nim & subdomain are required");

    // Validasi NIM
    const v = checkNim(nim);
    if (!v.valid) return bad(res, "NIM tidak valid", 404);

    // Proteksi per-NIM (Basic Auth untuk NIM tertentu)
    const authResp = enforceNimAuthOrResponse(req, res, v.nim);
    if (authResp) return; // response sudah dikirim jika gagal

    // Validasi subdomain
    const sub = sanitizeSub(subdomain);
    if (!sub)
      return bad(
        res,
        "Subdomain tidak valid. Gunakan a-z, 0-9, dash; min 3 karakter."
      );

    const db = await getDb();
    const subsCol = db.collection("subdomains");

    // Kuota subdomain: maks 3 per NIM
    const used = await subsCol.countDocuments({ nim: v.nim });
    if (used >= 3) return bad(res, "Kuota subdomain sudah penuh (maks 3).");

    const fqdn = `${sub}.${ROOT}`;

    // Cegah duplikasi global (nama subdomain unik di seluruh domain)
    const dup = await subsCol.findOne({ fqdn });
    if (dup) return bad(res, "Subdomain sudah dipakai.");

    // Buat CNAME di Cloudflare
    const cf = await createCNAME({ name: sub });

    // Simpan ke DB
    await subsCol.insertOne({
      nim: v.nim,
      sub,
      fqdn,
      cf_record_id: cf.id,
      target: cf.content,
      createdAt: new Date(),
    });

    // Pastikan entri owner ada
    await db.collection("owners").updateOne(
      { nim: v.nim },
      {
        $setOnInsert: {
          nim: v.nim,
          nama: v.nama,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    return ok(
      res,
      {
        ok: true,
        fqdn,
        usage: { subdomains: used + 1, remaining: 3 - (used + 1) },
      },
      201
    );
  } catch (e) {
    return bad(res, e.message, 500);
  }
});

// ====== Create Email Routing ======
app.post("/api/create-email", async (req, res) => {
  try {
    const { nim, local, subdomain, destination } = req.body || {};
    if (!nim || !local || !subdomain || !destination)
      return bad(
        res,
        "nim, local, subdomain, destination are required"
      );

    // Validasi NIM
    const v = checkNim(nim);
    if (!v.valid) return bad(res, "NIM tidak valid", 404);

    // Proteksi per-NIM
    const authResp = enforceNimAuthOrResponse(req, res, v.nim);
    if (authResp) return;

    // Validasi input
    if (!isValidEmailLocal(local))
      return bad(res, "Local-part email tidak valid.");
    if (!isValidDestinationEmail(destination))
      return bad(res, "Destination email tidak valid.");

    const sub = sanitizeSub(subdomain);
    if (!sub) return bad(res, "Subdomain tidak valid.");

    const db = await getDb();
    const subsCol = db.collection("subdomains");
    const emailsCol = db.collection("emails");

    // Subdomain harus milik NIM tsb
    const owned = await subsCol.findOne({ nim: v.nim, sub });
    if (!owned) return bad(res, "Subdomain bukan milik anda.");

    // Kuota email: maks 3 per NIM
    const used = await emailsCol.countDocuments({ nim: v.nim });
    if (used >= 3) return bad(res, "Kuota email routing sudah penuh (maks 3).");

    const email = `${local}@${sub}.${ROOT}`;

    // Cegah duplikasi alamat email
    const exists = await emailsCol.findOne({ email });
    if (exists) return bad(res, "Alamat email ini sudah digunakan.");

    // Buat Email Routing rule di Cloudflare (actions.value HARUS array)
    const dest = String(destination).trim().toLowerCase();
    const cf = await createEmailRoute({
      to: email,
      destination: dest,
      ruleName: `route-${v.nim}-${sub}-${local}`,
    });

    // Simpan ke DB
    await emailsCol.insertOne({
      nim: v.nim,
      email,
      subdomain: sub,
      destination: dest,
      cf_rule_id: cf.id,
      createdAt: new Date(),
    });

    return ok(
      res,
      {
        ok: true,
        email,
        usage: { emails: used + 1, remaining: 3 - (used + 1) },
      },
      201
    );
  } catch (e) {
    return bad(res, e.message, 500);
  }
});

// ====== List Usage by NIM ======
app.get("/api/list-usage", async (req, res) => {
  try {
    const nim = String(req.query.nim || "").trim();
    if (!nim) return bad(res, "nim is required");

    const v = checkNim(nim);
    if (!v.valid) return bad(res, "NIM tidak valid", 404);

    const db = await getDb();
    const subs = await db
      .collection("subdomains")
      .find({ nim: v.nim })
      .sort({ createdAt: -1 })
      .toArray();
    const mails = await db
      .collection("emails")
      .find({ nim: v.nim })
      .sort({ createdAt: -1 })
      .toArray();

    return ok(res, {
      nim: v.nim,
      nama: v.nama,
      usage: {
        subdomains: subs.length,
        emails: mails.length,
        subdomainsDetail: subs.map(({ _id, ...r }) => r),
        emailsDetail: mails.map(({ _id, ...r }) => r),
      },
    });
  } catch (e) {
    return bad(res, e.message, 500);
  }
});

// ====== Admin: List (summary atau detail) ======
app.get("/api/admin-list", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const {
      nim,
      page = "1",
      limit = "20",
      search = "",
      sort = "",
    } = req.query;

    const db = await getDb();
    const owners = db.collection("owners");
    const subsCol = db.collection("subdomains");
    const emailsCol = db.collection("emails");

    // DETAIL per NIM
    if (nim) {
      const owner = await owners.findOne({ nim });
      if (!owner) return bad(res, "NIM tidak ditemukan di owners", 404);

      const subs = await subsCol
        .find({ nim })
        .project({ _id: 0 })
        .sort({ createdAt: -1 })
        .toArray();

      const emails = await emailsCol
        .find({ nim })
        .project({ _id: 0 })
        .sort({ createdAt: -1 })
        .toArray();

      return ok(res, {
        mode: "detail",
        nim,
        nama: owner.nama,
        counts: { subdomains: subs.length, emails: emails.length },
        subdomains: subs,
        emails: emails,
      });
    }

    // SUMMARY semua NIM (paginated)
    const match = search
      ? {
          $or: [
            { nim: { $regex: search, $options: "i" } },
            { nama: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const sortStage =
      sort === "subs_desc"
        ? { subdomains: -1, nim: 1 }
        : sort === "emails_desc"
        ? { emails: -1, nim: 1 }
        : sort === "nim_desc"
        ? { nim: -1 }
        : { nim: 1 };

    const p = Math.max(1, parseInt(page, 10));
    const l = Math.min(100, Math.max(1, parseInt(limit, 10)));

    const agg = [
      { $match: match },
      {
        $lookup: {
          from: "subdomains",
          localField: "nim",
          foreignField: "nim",
          as: "subs",
        },
      },
      {
        $lookup: {
          from: "emails",
          localField: "nim",
          foreignField: "nim",
          as: "mails",
        },
      },
      {
        $project: {
          _id: 0,
          nim: 1,
          nama: 1,
          createdAt: 1,
          subdomains: { $size: "$subs" },
          emails: { $size: "$mails" },
        },
      },
      { $sort: sortStage },
      { $skip: (p - 1) * l },
      { $limit: l },
    ];

    const rows = await owners.aggregate(agg).toArray();
    const [{ total } = { total: 0 }] = await owners
      .aggregate([{ $match: match }, { $count: "total" }])
      .toArray();

    return ok(res, {
      mode: "summary",
      page: p,
      limit: l,
      totalOwners: total,
      pageOwners: rows.length,
      sort: sort || "nim_asc",
      search: search || null,
      pageTotals: {
        subdomains: rows.reduce((a, r) => a + (r.subdomains || 0), 0),
        emails: rows.reduce((a, r) => a + (r.emails || 0), 0),
      },
      data: rows,
    });
  } catch (e) {
    return bad(res, e.message, 500);
  }
});

// ====== Admin: Reset (hapus semua subdomain & email milik 1 NIM) ======
app.post("/api/admin-reset", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { nim, dryRun = true, confirm = false } = req.body || {};
    if (!nim) return bad(res, "nim is required");

    const v = checkNim(nim);
    if (!v.valid) return bad(res, "NIM tidak valid", 404);

    const db = await getDb();
    const subsCol = db.collection("subdomains");
    const emailsCol = db.collection("emails");

    const subs = await subsCol.find({ nim: v.nim }).toArray();
    const mails = await emailsCol.find({ nim: v.nim }).toArray();

    if ((subs?.length || 0) === 0 && (mails?.length || 0) === 0)
      return ok(res, {
        nim: v.nim,
        nama: v.nama,
        found: { subdomains: 0, emails: 0 },
        dryRun,
        confirm,
        message: "Tidak ada subdomain/email untuk direset.",
      });

    if (dryRun || !confirm)
      return ok(res, {
        nim: v.nim,
        nama: v.nama,
        dryRun: true,
        requiredConfirm: true,
        toDelete: {
          subdomains: subs.map((s) => ({
            fqdn: s.fqdn,
            cf_record_id: s.cf_record_id,
          })),
          emails: mails.map((e) => ({
            email: e.email,
            cf_rule_id: e.cf_rule_id,
          })),
        },
        hint: "Kirim lagi dengan { dryRun: false, confirm: true } untuk eksekusi.",
      });

    // Eksekusi hapus: Email dulu, lalu DNS
    const report = { subdomains: [], emails: [] };

    for (const e of mails) {
      try {
        if (e.cf_rule_id) await deleteEmailRoute(e.cf_rule_id);
        report.emails.push({ email: e.email, status: "deleted" });
      } catch (err) {
        report.emails.push({
          email: e.email,
          status: "failed",
          error: String(err.message || err),
        });
      }
    }

    for (const s of subs) {
      try {
        if (s.cf_record_id) await deleteDNSRecord(s.cf_record_id);
        report.subdomains.push({ fqdn: s.fqdn, status: "deleted" });
      } catch (err) {
        report.subdomains.push({
          fqdn: s.fqdn,
          status: "failed",
          error: String(err.message || err),
        });
      }
    }

    const delEmails = await emailsCol.deleteMany({ nim: v.nim });
    const delSubs = await subsCol.deleteMany({ nim: v.nim });

    return ok(res, {
      nim: v.nim,
      nama: v.nama,
      dryRun: false,
      confirm: true,
      cloudflare: report,
      database: {
        emailsDeleted: delEmails.deletedCount,
        subdomainsDeleted: delSubs.deletedCount,
      },
    });
  } catch (e) {
    return bad(res, e.message, 500);
  }
});

// ====== 404 fallback untuk route API yang tidak ada ======
app.use("/api/", (req, res) => bad(res, "Endpoint not found", 404));

// ====== Start server ======
const port = process.env.PORT || 3000;
app.listen(port, () =>
  console.log("IKMI backend running on port " + port)
);
