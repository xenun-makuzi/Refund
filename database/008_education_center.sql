-- ============================================================
-- REFUND PLATFORM - FRAUD AWARENESS & EDUCATION CENTER
-- Migration 008. Requires migrations 001 through 007.
-- Run the complete file once in a new Supabase SQL Editor query.
-- Article body is plain text / limited Markdown, never trusted HTML.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.education_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL CHECK (char_length(trim(title)) BETWEEN 8 AND 160),
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(slug) BETWEEN 3 AND 160),
  excerpt TEXT NOT NULL CHECK (char_length(trim(excerpt)) BETWEEN 20 AND 320),
  category TEXT NOT NULL CHECK (category IN (
    'fraud_awareness',
    'account_security',
    'claims_preparation',
    'service_safety',
    'recovery_process',
    'tax_refunds'
  )),
  content_markdown TEXT NOT NULL CHECK (char_length(trim(content_markdown)) BETWEEN 80 AND 20000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  featured BOOLEAN NOT NULL DEFAULT FALSE,
  read_time_minutes SMALLINT NOT NULL DEFAULT 3 CHECK (read_time_minutes BETWEEN 1 AND 60),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  CONSTRAINT education_article_published_timestamp CHECK (
    status <> 'published' OR published_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS education_articles_slug_lower_uidx
  ON public.education_articles (lower(slug));
CREATE INDEX IF NOT EXISTS education_articles_public_listing_idx
  ON public.education_articles (status, featured DESC, published_at DESC)
  WHERE status = 'published';
CREATE INDEX IF NOT EXISTS education_articles_category_idx
  ON public.education_articles (category, published_at DESC)
  WHERE status = 'published';

CREATE OR REPLACE FUNCTION public.touch_education_article()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();

  IF TG_OP = 'INSERT' AND NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'published' THEN
      NEW.published_at := COALESCE(NEW.published_at, now());
    ELSE
      NEW.published_at := NULL;
    END IF;
  ELSE
    IF NEW.status = 'published' THEN
      IF OLD.status IS DISTINCT FROM 'published' OR NEW.published_at IS NULL THEN
        NEW.published_at := now();
      END IF;
    ELSE
      NEW.published_at := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.touch_education_article() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS education_articles_touch_updated_at ON public.education_articles;
CREATE TRIGGER education_articles_touch_updated_at
BEFORE INSERT OR UPDATE ON public.education_articles
FOR EACH ROW EXECUTE FUNCTION public.touch_education_article();

-- Record metadata only; never write article body contents into the audit stream.
CREATE OR REPLACE FUNCTION public.audit_education_article_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id UUID;
  v_title TEXT;
  v_slug TEXT;
  v_status TEXT;
  v_action TEXT;
  v_summary TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_id := OLD.id;
    v_title := OLD.title;
    v_slug := OLD.slug;
    v_status := OLD.status;
    v_action := 'education_article_deleted';
    v_summary := 'Education article archived or deleted: ' || left(OLD.title, 300);
  ELSE
    v_id := NEW.id;
    v_title := NEW.title;
    v_slug := NEW.slug;
    v_status := NEW.status;
    IF TG_OP = 'INSERT' THEN
      v_action := CASE WHEN NEW.status = 'published' THEN 'education_article_published' ELSE 'education_article_created' END;
      v_summary := 'Education article created: ' || left(NEW.title, 300);
    ELSIF OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'published' THEN
      v_action := 'education_article_published';
      v_summary := 'Education article published: ' || left(NEW.title, 300);
    ELSIF OLD.status = 'published' AND NEW.status <> 'published' THEN
      v_action := 'education_article_unpublished';
      v_summary := 'Education article removed from public listing: ' || left(NEW.title, 300);
    ELSE
      v_action := 'education_article_updated';
      v_summary := 'Education article updated: ' || left(NEW.title, 300);
    END IF;
  END IF;

  INSERT INTO public.security_audit_events (
    actor_id, action_key, entity_type, entity_id, summary, metadata
  ) VALUES (
    auth.uid(), v_action, 'education_article', v_id, left(v_summary, 500),
    jsonb_build_object('title', v_title, 'slug', v_slug, 'status', v_status, 'operation', TG_OP)
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.audit_education_article_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS education_articles_audit_change ON public.education_articles;
CREATE TRIGGER education_articles_audit_change
AFTER INSERT OR UPDATE OR DELETE ON public.education_articles
FOR EACH ROW EXECUTE FUNCTION public.audit_education_article_change();

ALTER TABLE public.education_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Education articles: public read published" ON public.education_articles;
DROP POLICY IF EXISTS "Education articles: admin read all" ON public.education_articles;
DROP POLICY IF EXISTS "Education articles: admin insert" ON public.education_articles;
DROP POLICY IF EXISTS "Education articles: admin update" ON public.education_articles;

CREATE POLICY "Education articles: public read published"
ON public.education_articles
FOR SELECT
TO anon, authenticated
USING (
  status = 'published'
  AND published_at IS NOT NULL
  AND published_at <= now()
);

CREATE POLICY "Education articles: admin read all"
ON public.education_articles
FOR SELECT
TO authenticated
USING (public.is_admin());

CREATE POLICY "Education articles: admin insert"
ON public.education_articles
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin());

CREATE POLICY "Education articles: admin update"
ON public.education_articles
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

REVOKE ALL ON TABLE public.education_articles FROM anon, authenticated;
GRANT SELECT ON TABLE public.education_articles TO anon, authenticated;
GRANT INSERT, UPDATE ON TABLE public.education_articles TO authenticated;

-- Starter educational content. These articles provide general awareness, not legal/tax advice.
-- ON CONFLICT keeps reruns from replacing edits made by administrators.
INSERT INTO public.education_articles
  (title, slug, excerpt, category, content_markdown, status, featured, read_time_minutes)
VALUES
(
  'How to recognize a recovery scam',
  'recognize-a-recovery-scam',
  'Learn common warning signs when someone claims they can recover money you have already lost.',
  'fraud_awareness',
  $article$Losing money can be stressful, and follow-up messages promising to get it back can feel hopeful. Unfortunately, some scammers target people who have already experienced a loss.

## Warning signs to take seriously
- Someone guarantees that they will recover your money or promises a specific outcome before reviewing the facts.
- A person pressures you to act immediately, keep the conversation secret, or ignore advice from your bank or authorities.
- Someone asks for your password, one-time verification code, remote access to your device, or the seed phrase to a crypto wallet.
- Payment instructions change unexpectedly or the recipient cannot be independently verified.
- The sender claims to represent a regulator, police agency, bank, or well-known company but asks you to contact them only through an unverified account.

## Safer next steps
Pause before sending money or information. Contact your bank, card provider, payment app, or relevant organization through contact details you find independently. Preserve messages, receipts, transaction references, and dates. Report suspected fraud through appropriate official channels in your jurisdiction.

A legitimate service should explain what it does, how it charges, what information it needs, and what it cannot guarantee. This guide is general awareness information, not a finding about any particular person or company.$article$,
  'published', TRUE, 4
),
(
  'Protect your accounts and identity documents',
  'protect-accounts-and-identity-documents',
  'Practical steps for sharing identity documents more safely and keeping online accounts under your control.',
  'account_security',
  $article$Identity documents and account credentials can expose you to further fraud if they reach the wrong person. Share only what is necessary for a clearly explained purpose.

## Before you upload a document
- Check that you are on the genuine website or application and that the organization and purpose are clear.
- Read the privacy notice to understand how the document will be used, who may access it, and how long it may be retained.
- Ask whether every requested field is necessary. Do not send extra documents simply because someone asks urgently.
- Use a secure upload workflow rather than posting identity documents in public comments or open chat groups.

## Keep accounts secure
Use a unique password and enable multi-factor authentication when available. Never share one-time codes, passwords, recovery codes, wallet seed phrases, or remote-access credentials with support staff. Be cautious about screen-sharing requests.

If you suspect an account is compromised, use the provider's official security process to change credentials, end unfamiliar sessions, and notify the relevant financial institution. Follow local reporting requirements where appropriate.$article$,
  'published', TRUE, 4
),
(
  'Prepare records before submitting a claim',
  'prepare-records-before-submitting-a-claim',
  'A checklist for organizing dates, correspondence, receipts, and other information that may help a claim review.',
  'claims_preparation',
  $article$Organized records can help a reviewer understand what happened. Submit accurate information and distinguish what you know from what you suspect.

## Useful records to gather
- Dates of the transaction and relevant conversations.
- Receipts, invoices, order confirmations, or account statements with unnecessary details hidden where appropriate.
- Messages exchanged with the business, platform, or person involved.
- Transaction references and the payment method used. Do not share full passwords, card security codes, or authentication codes.
- A short timeline describing what happened, what outcome you requested, and any response you received.

## Before you submit
Check that your description is consistent with the records. Keep originals in a safe place, avoid editing evidence in a way that changes its meaning, and provide only documents relevant to the case. If a form asks for information you do not understand, request clarification rather than guessing.

Submitting a claim does not mean it will be accepted or that money will be recovered. A reviewer may need more information, and appropriate deadlines or dispute procedures may vary by provider and jurisdiction.$article$,
  'published', FALSE, 3
),
(
  'How to evaluate a refund or recovery service',
  'evaluate-a-refund-or-recovery-service',
  'Questions to ask about a service, its fees, its authority, its process, and its limitations before you proceed.',
  'service_safety',
  $article$Before trusting a service to help with a refund or recovery, take time to understand who operates it and what it is offering. A professional-looking website alone is not proof of legitimacy.

## Questions worth asking
- What is the legal name of the organization, and how can it be independently contacted?
- What service will be performed, and what documents are needed for that purpose?
- What fees or deductions may apply, when are they payable, and under what circumstances?
- Is the service authorized or qualified for the specific activity and jurisdiction where required?
- What happens if the request is unsuccessful, delayed, or disputed?
- How are personal data and identity documents protected, and how can you make a complaint?

## Take time to verify
Search for independent information about the organization and verify any claimed registration or affiliation through the relevant official source. Do not rely only on screenshots, testimonials, badges, or links supplied by the person contacting you. Read the terms before agreeing and keep a copy of your agreement and receipts.

Be cautious of guaranteed outcomes or pressure to make urgent payments. Different services have different business models, so understand the actual terms rather than assuming a fee model alone proves whether a service is legitimate.$article$,
  'published', FALSE, 4
),
(
  'What to expect during a recovery review',
  'what-to-expect-during-a-recovery-review',
  'Understand the difference between submitting a request, an investigation, a recovery attempt, and money actually received.',
  'recovery_process',
  $article$Recovery-related cases often involve several separate steps. Knowing what each step means can help you interpret updates accurately.

## Common stages
- **Request submitted:** the service has received your information. It may not yet have determined whether the case can proceed.
- **Initial review:** the available information is checked for completeness and potential next steps. More documents may be requested.
- **Investigation or dispute process:** the responsible organization assesses evidence and may contact other parties or payment providers where appropriate.
- **Recovery attempt:** a request, dispute, or other authorized action has been initiated. This is not the same as money being received.
- **Confirmed recovery:** a payment or transfer has been verified according to the service's process. If money arrives in installments, each installment should be recorded separately.

## Keep expectations realistic
Timing and outcomes depend on the transaction, other parties, evidence, provider rules, and applicable law. No general guide can guarantee a specific result. Ask the service how it defines each status and how it confirms recovered funds.

Keep your own records and contact the relevant financial provider directly when you need to confirm a transaction. A status update or screenshot is not, by itself, proof that money has reached your account.$article$,
  'published', FALSE, 4
),
(
  'Finding reliable tax refund information',
  'finding-reliable-tax-refund-information',
  'Use official tax authority information and be careful with unsolicited messages about tax refunds.',
  'tax_refunds',
  $article$Tax refund eligibility, filing rules, deadlines, and procedures differ by country and can change. The safest starting point is the official tax authority for the jurisdiction involved.

## Safer ways to check a tax refund
- Navigate to the tax authority's official website independently instead of following an unexpected text or email link.
- Check the exact tax year, filing status, and reference information relevant to your situation.
- Do not share account passwords, one-time codes, or full identity details with someone who contacts you unexpectedly.
- Review any fee agreement carefully if you use a tax preparation or assistance service.
- Keep copies of filings, notices, and confirmation numbers.

## Watch for impersonation
An unexpected message saying a refund is waiting may be designed to collect personal information or payment details. Verify the message using an official channel before responding. If you are unsure of your obligations or eligibility, consult the appropriate tax authority or a qualified tax professional in your jurisdiction.

This article is general information only. It is not tax advice and does not replace official instructions for your location.$article$,
  'published', FALSE, 3
)
ON CONFLICT (slug) DO NOTHING;

COMMIT;

-- Public visitors can read published articles only.
-- Editing, publishing, archiving, and deletion require an authenticated admin role.
-- This migration does not provide legal or tax advice, nor does it verify external affiliations.
