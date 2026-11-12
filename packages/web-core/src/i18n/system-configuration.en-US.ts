export const systemConfigurationEnUS = {
  generated: {
    systemConfigurationPage: {
      manageRuntimeSettings: 'Manage runtime settings.',
      unableToLoadSystemConfiguration: 'Unable to load system configuration',
      systemConfigurationSaved: 'System configuration saved',
      unableToSaveSystemConfiguration: 'Unable to save system configuration',
      systemConfiguration: 'System Configuration',
      refresh: 'Refresh',
      setting: 'Setting',
      description: 'Description',
      value: 'Value',
      actions: 'Actions',
      edit: 'Edit',
      save: 'Save',
      skillSourceTLSCertificateVerificationIsDisabled:
        'Skill source TLS certificate verification is disabled. Downloaded versions will be marked as unverified.',
      disableSkillSourceTLSVerification: 'Disable Skill Source TLS Verification',
      htmlPreviewOrigin: 'HTML preview origin',
      htmlPreviewOriginDescription:
        'Empty uses the Console origin, where HTML runs with your permissions. A separate origin must route previews to this Server.',
      htmlPreviewOriginPlaceholder: 'https://preview.example.com (leave empty for current origin)',
      htmlPreviewOriginInvalid:
        'Enter an HTTP or HTTPS origin without a path, or leave this empty.',
      htmlPreviewCurrentOrigin: 'Current Console origin',
      keepThisOffByDefaultUseIt:
        'Keep this off by default. Use it only to troubleshoot internal self-signed certificates; repository host and path validation remain enforced.',
      smtp: 'Email SMTP configuration',
      smtpDescription: 'Configure the deployment-wide SMTP sending service.',
      smtpPlaceholder: 'SMTP connection configuration',
      smtpInvalid: 'SMTP configuration exceeds the allowed length.',
      smtpEnable: 'Enable email sending',
      smtpHost: 'SMTP host',
      smtpHostInvalid: 'Enter a valid SMTP hostname.',
      smtpPort: 'Port',
      smtpPortInvalid: 'Enter a port from 1 to 65535.',
      smtpTls: 'TLS mode',
      smtpFrom: 'Sender address',
      smtpFromInvalid: 'Enter a valid sender email address.',
      smtpFromName: 'Sender name',
      smtpFromNameInvalid:
        'The sender name must not contain a newline and must be at most 128 characters.',
      smtpUsername: 'Authentication username (optional)',
      smtpUsernameInvalid:
        'The username must not contain a newline and must be at most 320 characters.',
      smtpPassword: 'Authentication password (optional)',
      smtpPasswordKeep: 'Leave blank to keep the saved password',
      smtpPasswordInvalid:
        'Enter a password for a new username; leave blank to retain the password for the same username. Maximum 1,024 characters.',
      smtpDisableTitle: 'Disable email sending',
      smtpDisableConfirmation:
        'Disabling email will delete the saved SMTP configuration and password. You will need to enter them again to re-enable it. Continue?',
      smtpDialogHint:
        'Passwords are hidden after saving. Leave blank to keep the saved password when the username is unchanged. Test email uses the saved configuration.',
      mailTemplates: 'Email templates',
      mailTemplateView: 'View email templates',
      mailTemplateBuiltIn:
        'Built-in test and notification templates are read-only. The preview shows the email as sent.',
      mailTemplateSample: 'Template text',
      mailPreviewSample: 'Email preview',
      mailTemplateEmpty: 'No built-in email templates found. Check the Server database migration.',
      mailTest: 'Send test email',
      mailTestSend: 'Send test',
      mailTestAccepted:
        'The SMTP server accepted the test email; inbox delivery is not guaranteed.',
      mailAddressInvalid: 'Enter a valid email address.',
      mailAddress: 'Recipient email',
      mailTemplate: 'Test template',
      mailKindTest: 'Test',
      mailKindNotification: 'Notification',
      mailSubject: 'Subject',
      mailBody: 'Plain-text body',
      mailPreviewMessage: 'Example notification message',
      mailOperationFailed: 'Email operation failed'
    }
  }
} as const;
