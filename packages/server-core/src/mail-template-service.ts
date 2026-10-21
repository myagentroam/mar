import type { Pool, RowDataPacket } from 'mysql2/promise';
import { mailTemplatesZhCN } from './i18n/mail-templates.zh-CN.js';
import { mailTemplatesEnUS } from './i18n/mail-templates.en-US.js';

export type MailTemplateKind = 'TEST' | 'NOTIFICATION';
export interface MailTemplate {
  readonly id: string;
  readonly kind: MailTemplateKind;
  readonly locale: 'zh-CN' | 'en-US';
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly revision: number;
  readonly isDefault: boolean;
}
export interface MailVariables {
  readonly title: string;
  readonly message: string;
  readonly userName: string;
  readonly workspaceName: string;
  readonly email: string;
}

const VARIABLES = ['title', 'message', 'userName', 'workspaceName', 'email'] as const;
const SELECT = 'SELECT id,kind,locale,name,subject,body,revision,is_default FROM mail_templates';

export function mailTemplateContent(locale: MailTemplate['locale']) {
  return locale === 'zh-CN' ? mailTemplatesZhCN : mailTemplatesEnUS;
}

export class MailTemplateService {
  constructor(private readonly database: { readonly raw: Pool }) {}

  async list(): Promise<readonly MailTemplate[]> {
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `${SELECT} WHERE is_default=1 ORDER BY kind,locale`
    );
    return rows.map(fromRow);
  }

  async get(id: string, kind?: MailTemplateKind): Promise<MailTemplate> {
    if (!/^[a-zA-Z0-9-]{1,64}$/u.test(id)) throw new Error('MAIL_TEMPLATE_NOT_FOUND');
    const [rows] = await this.database.raw.execute<RowDataPacket[]>(
      `${SELECT} WHERE id=? AND is_default=1`,
      [id]
    );
    if (rows.length === 0 || (kind !== undefined && rows[0]!['kind'] !== kind))
      throw new Error('MAIL_TEMPLATE_NOT_FOUND');
    return fromRow(rows[0]!);
  }

  async render(
    id: string,
    kind: MailTemplateKind,
    variables: MailVariables
  ): Promise<{ readonly subject: string; readonly text: string; readonly html: string }> {
    const template = await this.get(id, kind);
    const values =
      kind === 'NOTIFICATION' && variables.title.trim().length === 0
        ? { ...variables, title: mailTemplateContent(template.locale).notification.defaultTitle }
        : variables;
    const substitute = (value: string) =>
      value.replace(/\{\{([^{}]+)\}\}/gu, (_match, key: string) => {
        if (!VARIABLES.includes(key as (typeof VARIABLES)[number]))
          throw new Error('MAIL_TEMPLATE_INVALID');
        return values[key as keyof MailVariables];
      });
    const subject = substitute(template.subject);
    const text = substitute(template.body);
    if (
      subject.length === 0 ||
      subject.length > 256 ||
      /[\r\n]/u.test(subject) ||
      text.length === 0 ||
      text.length > 10_000
    )
      throw new Error('MAIL_INPUT_INVALID');
    return { subject, text, html: renderHtml(template, subject, text) };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function renderHtml(template: MailTemplate, subject: string, text: string): string {
  const copy = mailTemplateContent(template.locale).presentation;
  const content = escapeHtml(text).replace(/\r\n|\r|\n/gu, '<br>');
  // All variable data is escaped before it enters this server-owned email layout.
  return `<!doctype html>
<html lang="${template.locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fa;color:#263238;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;background:#f5f7fa;">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="620" style="width:100%;max-width:620px;border-collapse:collapse;background:#ffffff;">
        <tr><td style="padding:24px 32px 18px;border-bottom:1px solid #e7ebef;color:#1f2933;font-size:16px;font-weight:700;letter-spacing:.01em;">
          MyAgentRoam
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 24px;color:#1f2933;font-size:22px;font-weight:700;line-height:1.35;">${escapeHtml(subject)}</h1>
          <div style="color:#354052;font-size:15px;line-height:1.8;overflow-wrap:break-word;">${content}</div>
        </td></tr>
        <tr><td style="padding:18px 32px 24px;border-top:1px solid #e7ebef;color:#7a8491;font-size:12px;line-height:1.5;">${escapeHtml(copy.footer)}</td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function fromRow(row: RowDataPacket): MailTemplate {
  return {
    id: String(row['id']),
    kind: row['kind'] as MailTemplateKind,
    locale: row['locale'] as MailTemplate['locale'],
    name: String(row['name']),
    subject: String(row['subject']),
    body: String(row['body']),
    revision: Number(row['revision']),
    isDefault: Boolean(row['is_default'])
  };
}
