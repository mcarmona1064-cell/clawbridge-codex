import cors from 'cors';

export const corsMiddleware = cors({
  origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:4000', 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
