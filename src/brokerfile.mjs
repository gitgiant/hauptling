import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './util.mjs';

export const brokerFile = () => join(home(), 'broker.json');
export const readBrokerFile = () => (existsSync(brokerFile()) ? JSON.parse(readFileSync(brokerFile(), 'utf8')) : null);
