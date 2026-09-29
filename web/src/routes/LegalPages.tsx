import type { ReactNode } from 'react';
import { BrandMark } from '../components/ui.tsx';

/**
 * Public privacy notice and terms of use, linked from the sign-in page and from
 * Google's sign-in consent screen. Static on purpose: they must load even when the
 * API is down. The student-facing attendance policy (backend/src/policy.ts) says the
 * same about location and retention; keep the two in step.
 */

const UPDATED = '27 September 2026';

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="login-wrap">
      <div className="login-card legal">
        <a className="brand" href="/">
          <BrandMark />
          <span>Argus</span>
        </a>
        <div className="card">
          <h1>{title}</h1>
          <p className="muted small">Last updated {UPDATED}</p>
          {children}
          <p className="muted small" style={{ marginTop: '1.5rem' }}>
            <a href="/privacy">Privacy</a> · <a href="/terms">Terms of use</a> · <a href="/">Sign in</a>
          </p>
        </div>
      </div>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice">
      <p>
        Argus is the attendance system of S-VYASA School of Advanced Studies. It is used by the college's students, teachers and staff. This notice explains what Argus
        stores and why.
      </p>
      <h2>Signing in with Google</h2>
      <p>
        When you sign in with Google, Argus receives only your name, your email address and Google's identifier for your account. It uses them to recognise you and match
        you to your college record. Argus does not read your email, contacts, files or anything else in your Google account.
      </p>
      <h2>What Argus stores</h2>
      <ul>
        <li>Your college details: name, email, roll number (USN), section and lab batch, as provided by Academic Operations.</li>
        <li>Your attendance: which classes you were marked present, late or absent for, and any corrections with who made them and why.</li>
        <li>
          For students, your registered phone: its model, system version, the app version and public keys created on the phone. The private keys never leave the phone.
        </li>
        <li>
          Location, for students, only at the moment you scan an attendance code. Argus keeps only whether you were on campus and how accurate the reading was, never
          your coordinates. There is no background tracking.
        </li>
        <li>Notices from Academic Operations, and whether you have read them.</li>
        <li>A security log of sign-ins and changes, so every access to attendance evidence can be traced.</li>
      </ul>
      <h2>How long it is kept</h2>
      <p>Details of individual scan attempts are deleted after 90 days. Attendance records are kept for as long as university rules require.</p>
      <h2>Who can see it</h2>
      <p>
        Only you and authorised college staff (your teachers and Academic Operations), and every access to attendance evidence is logged. Argus
        does not sell data, show advertising or share data with anyone else. Hosting providers store it on the college's behalf: Vercel runs the service and Neon
        provides the database.
      </p>
      <h2>Questions or corrections</h2>
      <p>Contact Academic Operations. They can show you what Argus holds about you and correct mistakes.</p>
    </LegalPage>
  );
}

export function TermsPage() {
  return (
    <LegalPage title="Terms of use">
      <p>Argus is provided by S-VYASA School of Advanced Studies for taking attendance. By using it you agree to the following.</p>
      <ul>
        <li>Argus is only for the college's students, teachers and staff, using their own college account.</li>
        <li>Mark attendance only for yourself, only when you are in the class, on the phone registered to you.</li>
        <li>
          Proxy attendance is not allowed: marking attendance for someone else, letting someone mark it for you, or lending your registered phone or login. The college
          deals with it under its own rules.
        </li>
        <li>Do not try to get around Argus's checks, for example by altering the app, faking your location or copying attendance codes.</li>
        <li>If Argus does not work for you in class, use "Ask for help" in the app or tell your teacher; your attendance can be confirmed or corrected.</li>
      </ul>
      <p>The college may change these terms; the date above shows the latest version. See the <a href="/privacy">privacy notice</a> for how your data is handled.</p>
    </LegalPage>
  );
}
