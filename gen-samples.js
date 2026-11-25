const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

// --- 1. Load goals from data.js ---
const source = fs.readFileSync("./data.js", "utf8");
const jsonStr = source.replace(/^\s*window\.REPORT_DATA\s*=\s*/, "").replace(/;\s*$/, "");
const goals = JSON.parse(jsonStr).goals || [];

const TODAY = "2026-11-25";

function makeReportNumber(type, index) {
  const prefix = type === "Mobilization" ? "MOB" : type === "Monitoring" ? "MON" : "FOL";
  return prefix + "-2026-" + String(index).padStart(3, "0");
}

function buildSampleReport(goal, type, seqIndex) {
  const reportNumber = makeReportNumber(type, seqIndex);
  const legacyId = type.toUpperCase() + "-" + goal.refNo + "-" + seqIndex;
  const fields = {
    reportNumber,
    pageDate: TODAY,
    visitDate: TODAY,
    visitType: type,
    staffName: "Admin",
    staffRole: "Umukozi ushinzwe Ubworozi",
    staffPhone: "",
    reportStatus: "Draft",
    authorityName: "NDAYAMBAJE KARIMA Augustin",
    authorityTitle: "Executive Secretary/Cyuve Sector",
    memoText: "",
    goal: goal.title,
    goalTitle: goal.title,
    goalCategory: goal.category,
    cell: "KABEZA",
    village: "",
    beneficiaryName: "",
    sector: "CYUVE"
  };
  const target = {
    id: crypto.randomUUID(),
    category: goal.category,
    goal: goal.title,
    customGoal: "",
    searchQuery: "",
    beneficiaries: "",
    sector: "CYUVE",
    cell: "KABEZA",
    village: "",
    customVillage: "",
    details: {}
  };
  const staff = [{
    name: "Admin",
    role: "Umukozi ushinzwe Ubworozi",
    phone: "",
    signature: ""
  }];
  return {
    legacyId,
    report: {
      version: 4,
      fields,
      targets: [target],
      staffParticipants: staff,
      authorityName: fields.authorityName,
      authorityTitle: fields.authorityTitle,
      memoText: fields.memoText
    }
  };
}

// Build samples: one Mobilization + one Monitoring per goal that supports each type
const samples = [];
let mobSeq = 0, monSeq = 0;

goals.forEach((goal) => {
  if (goal.visitTypes.includes("Mobilization")) {
    mobSeq++;
    samples.push(buildSampleReport(goal, "Mobilization", mobSeq));
  }
  if (goal.visitTypes.includes("Monitoring")) {
    monSeq++;
    samples.push(buildSampleReport(goal, "Monitoring", monSeq));
  }
});

console.log("Generated samples:");
console.log("  Mobilization:", mobSeq);
console.log("  Monitoring:", monSeq);
console.log("  Total:", samples.length);

// --- 2. Save samples to a file for reference ---
fs.writeFileSync("./sample-reports.json", JSON.stringify({ reports: samples }, null, 2));
console.log("Saved to ./sample-reports.json");

module.exports = { samples };
