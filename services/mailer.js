const { Resend } = require('resend');

// If RESEND_API_KEY isn't set, log the email instead of failing — keeps local dev and
// first-time setup working without forcing an email provider decision immediately.
// In production, set RESEND_API_KEY or emails silently won't send (only logged), which
// would break password reset in practice.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

async function sendMail({ to, subject, html, text }) {
  if (!resend) {
    console.log(`[mailer] RESEND_API_KEY not set — would have sent to ${to}: "${subject}"\n${text || html}`);
    return;
  }
  try {
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM || 'FlutterDataPlug <onboarding@resend.dev>',
      to,
      subject,
      html,
      text,
    });
    if (error) {
      console.error('Resend send failed:', error.message || error);
      throw new Error(error.message || 'Email send failed.');
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
    throw err;
  }
}

module.exports = { sendMail };
