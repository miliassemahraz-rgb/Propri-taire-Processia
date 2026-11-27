'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  AI_PROVIDER_IDS,
  DEFAULT_MODEL_KEY,
  type AiCapabilitiesDto,
  type AiConfigDto,
  type CapabilityWarning,
  type ClientDto,
} from '@processia/contracts';
import { t } from '@processia/i18n';
import { Button, Checkbox, Notice, Select, showToast, Tabs, TextField } from '@processia/ui';
import { ApiRequestError } from '../lib/api';
import { endpoints } from '../lib/endpoints';
import { errorMessage } from '../lib/errors';

type Provider = (typeof AI_PROVIDER_IDS)[number];

const TAB_CONFIG = 'config';
const TAB_POLICY = 'policy';
const CAPABILITY_KEYS = ['text', 'documents', 'audio'] as const;
const DEFAULT_CAPABILITIES: AiCapabilitiesDto = { text: true, documents: true, audio: false };

function Warnings({ warnings }: { warnings: CapabilityWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <Notice tone="warning" role="status">
      <ul className="plain">
        {warnings.map((warning) => (
          <li key={warning.capability}>{t(`warnings.CAPABILITY_MISSING.${warning.capability}`)}</li>
        ))}
      </ul>
    </Notice>
  );
}

function ConfigForm({ client }: { client: ClientDto }) {
  const [loaded, setLoaded] = useState(false);
  const [existing, setExisting] = useState<AiConfigDto | null>(null);
  const [provider, setProvider] = useState<Provider>('fake');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const [active, setActive] = useState(true);
  const [capabilities, setCapabilities] = useState<AiCapabilitiesDto>(DEFAULT_CAPABILITIES);
  const [accept, setAccept] = useState(false);
  const [policy, setPolicy] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<CapabilityWarning[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    (async () => {
      try {
        const config = await endpoints.getAiConfig(client.id);
        if (cancelled) return;
        setExisting(config);
        setProvider(config.provider);
        setModel(config.models[DEFAULT_MODEL_KEY] ?? '');
        setBudget(config.monthlyBudgetEur === null ? '' : String(config.monthlyBudgetEur));
        setActive(config.active);
        setCapabilities(config.capabilities);
        setWarnings(config.warnings);
        setAccept(false);
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiRequestError && caught.code === 'NOT_FOUND') {
          setExisting(null);
          setProvider('fake');
          setModel('');
          setBudget('');
          setActive(true);
          setCapabilities(DEFAULT_CAPABILITIES);
          setWarnings([]);
        } else {
          setError(errorMessage(caught));
        }
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [client.id]);

  useEffect(() => {
    let cancelled = false;
    endpoints.dataPolicy(provider).then(
      (result) => {
        if (!cancelled) setPolicy(result.text);
      },
      () => {
        if (!cancelled) setPolicy(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [provider]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = await endpoints.putAiConfig(client.id, {
        provider,
        capabilities,
        active,
        ...(apiKey === '' ? {} : { apiKey }),
        ...(model.trim() === '' ? {} : { models: { [DEFAULT_MODEL_KEY]: model.trim() } }),
        ...(budget.trim() === '' ? {} : { monthlyBudgetEur: Number(budget) }),
        ...(accept ? { acceptDataPolicy: true } : {}),
      });
      setExisting(saved);
      setWarnings(saved.warnings);
      setApiKey('');
      setAccept(false);
      showToast({ tone: 'success', title: t('admin.ai.saved') });
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  if (!loaded) return <p role="status">{t('ui.loading')}</p>;

  const external = provider !== 'fake';
  const alreadyAccepted =
    existing?.policyAcceptedAt !== null &&
    existing?.policyAcceptedAt !== undefined &&
    existing.provider === provider;

  const configTab = (
    <form onSubmit={(event) => void onSubmit(event)} className="stack">
      {existing === null ? <Notice tone="info">{t('admin.ai.none')}</Notice> : null}
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      <Warnings warnings={warnings} />
      <Select
        label={t('admin.ai.provider')}
        placeholder={t('admin.ai.providerPlaceholder')}
        options={AI_PROVIDER_IDS.map((id) => ({ id, label: t(`admin.ai.providers.${id}`) }))}
        value={provider}
        onChange={(value) => setProvider(value as Provider)}
      />
      {external ? (
        <TextField
          label={t('admin.ai.apiKey')}
          type="password"
          autoComplete="off"
          description={
            existing?.apiKey.configured
              ? t('admin.ai.apiKeyConfigured', { masked: existing.apiKey.masked ?? '' })
              : t('admin.ai.apiKeyNone')
          }
          value={apiKey}
          onChange={setApiKey}
        />
      ) : null}
      <TextField
        label={t('admin.ai.defaultModel')}
        description={t('admin.ai.defaultModelHint')}
        value={model}
        onChange={setModel}
      />
      <TextField
        label={t('admin.ai.budget')}
        inputMode="numeric"
        value={budget}
        onChange={setBudget}
      />
      <fieldset className="fieldset">
        <legend className="label-like">{t('admin.ai.capabilities')}</legend>
        {CAPABILITY_KEYS.map((key) => (
          <Checkbox
            key={key}
            isSelected={capabilities[key]}
            onChange={(value) => setCapabilities({ ...capabilities, [key]: value })}
          >
            {t(`admin.ai.cap.${key}`)}
          </Checkbox>
        ))}
      </fieldset>
      <Checkbox isSelected={active} onChange={setActive}>
        {t('admin.ai.active')}
      </Checkbox>
      {external ? (
        alreadyAccepted ? (
          <Notice tone="success">
            {t('admin.ai.acceptedAt', {
              date: new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' }).format(
                new Date(existing?.policyAcceptedAt ?? Date.now()),
              ),
            })}
          </Notice>
        ) : (
          <Checkbox isSelected={accept} onChange={setAccept}>
            {t('admin.ai.accept')}
          </Checkbox>
        )
      ) : null}
      <div>
        <Button type="submit" isDisabled={busy}>
          {t('admin.ai.submit')}
        </Button>
      </div>
    </form>
  );

  const policyTab = (
    <div className="stack">
      {external && policy !== null ? (
        <p>{policy}</p>
      ) : (
        <p className="muted">{t('admin.ai.policyNone')}</p>
      )}
      {external ? <p className="muted small">{t('admin.ai.acceptRequired')}</p> : null}
    </div>
  );

  return (
    <Tabs
      label={t('admin.ai.tabs.label')}
      items={[
        { id: TAB_CONFIG, label: t('admin.ai.tabs.config'), content: configTab },
        { id: TAB_POLICY, label: t('admin.ai.tabs.policy'), content: policyTab },
      ]}
    />
  );
}

export function AdminAiPage() {
  const [clients, setClients] = useState<ClientDto[] | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    endpoints.listClients().then(
      (list) => {
        setClients(list);
        if (list[0] !== undefined) setClientId(list[0].id);
      },
      (caught: unknown) => setError(errorMessage(caught)),
    );
  }, []);

  const client = clients?.find((entry) => entry.id === clientId);
  return (
    <div className="stack-lg">
      <div>
        <h1>{t('admin.ai.heading')}</h1>
        <p className="muted">{t('admin.ai.intro')}</p>
      </div>
      {error ? (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      ) : null}
      {clients !== null && clients.length === 0 ? (
        <Notice tone="info">{t('admin.ai.noClients')}</Notice>
      ) : null}
      {clients !== null && clients.length > 0 ? (
        <div className="card stack">
          <Select
            label={t('admin.ai.client')}
            placeholder={t('admin.ai.clientPlaceholder')}
            options={clients.map((entry) => ({ id: entry.id, label: entry.name }))}
            value={clientId}
            onChange={setClientId}
          />
          {client ? <ConfigForm key={client.id} client={client} /> : null}
        </div>
      ) : null}
    </div>
  );
}
