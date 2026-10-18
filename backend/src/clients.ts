import { PrismaClient } from '@prisma/client';
import { Redis } from 'ioredis';
import { Client } from '@elastic/elasticsearch';
import { Queue } from 'bullmq';
import { config } from './config.js';
export const prisma = new PrismaClient();
export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const searchAddress = process.env.ELASTICSEARCH_URL;
const searchAuth = process.env.ELASTICSEARCH_API_KEY
  ? { auth: { apiKey: process.env.ELASTICSEARCH_API_KEY } }
  : process.env.ELASTICSEARCH_USERNAME && process.env.ELASTICSEARCH_PASSWORD
    ? { auth: { username: process.env.ELASTICSEARCH_USERNAME, password: process.env.ELASTICSEARCH_PASSWORD } }
    : {};
export const search = searchAddress
  ? new Client({ node: searchAddress.includes('://') ? searchAddress : `http://${searchAddress}`, ...searchAuth })
  : null;
export const emailQueue = new Queue('email-send', { connection: redis });
