import 'dotenv/config';
import { loadConfig } from './validate.js';

// Fails fast at boot if the configuration is unsafe (e.g. a placeholder JWT secret).
export const config = loadConfig(process.env);
