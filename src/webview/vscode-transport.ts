import type { ClientTransport } from '../client-core/transport';
import { onHostMessage, postToHost } from './vscode-api';

export const vscodeTransport: ClientTransport = { post: postToHost, onMessage: onHostMessage };
