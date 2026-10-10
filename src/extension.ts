import type * as vscode from 'vscode';
import { activateExtension, deactivateExtension } from './host/activate';

export const activate = (context: vscode.ExtensionContext): Promise<void> => activateExtension(context);
export const deactivate = (): Promise<void> => deactivateExtension();
