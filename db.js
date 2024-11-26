import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST, // Host do banco de dados
  user: process.env.DB_USER, // Usuário do banco
  password: process.env.DB_PASSWORD, // Senha do banco
  database: process.env.DB_NAME, // Nome do banco de dados
  port: process.env.DB_PORT || 3306, // Porta padrão do MySQL
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export default pool;
