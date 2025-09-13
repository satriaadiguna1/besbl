// utils/students.js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// aman di semua versi Node: memuat JSON via require()
const studentsArr = require("../data/data_khs_mahasiswa.json");

export function checkNim(nim) {
  const n = String(nim || "").trim();
  const f = studentsArr.find((x) => String(x.nim) === n);
  return f ? { valid: true, nim: f.nim, nama: f.nama } : { valid: false };
}

// (opsional) kalau ingin akses semua data
export const allStudents = () => studentsArr;
