import postgres from "postgres";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Database configuration using PostgreSQL standard environment variables
const sql = postgres({
  host: process.env.PGHOST || "localhost",
  port: parseInt(process.env.PGPORT || "5432"),
  database: process.env.PGDATABASE || "strategy_execution_dev",
  username: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "",
  ssl: process.env.PGSSL === "true" ? "require" : false,
  max: parseInt(process.env.PGMAXCONNECTIONS || "10"), // connection pool size
  idle_timeout: parseInt(process.env.PGIDLE_TIMEOUT || "20"),
  connect_timeout: parseInt(process.env.PGCONNECT_TIMEOUT || "30"), // Increased timeout
  onnotice: () => {}, // Suppress notices
});

export default sql;
