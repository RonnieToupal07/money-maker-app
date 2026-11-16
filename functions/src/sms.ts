/** Sends a text through Twilio's REST API (no SDK needed). */
export async function sendSms(opts: { accountSid: string; authToken: string; from: string; to: string; body: string }) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${opts.accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: opts.from, To: opts.to, Body: opts.body }),
  });
  if (!res.ok) throw new Error(`Twilio error ${res.status}: ${await res.text()}`);
}
