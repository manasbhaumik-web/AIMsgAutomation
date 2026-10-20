import { Inject, Injectable } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { GoogleCalendarConnector } from './gcal.connector';
import { GmailConnector } from './gmail.connector';
import { msOAuth } from './graph';
import { OAuthClient } from './oauth';
import { MicrosoftCalendarConnector } from './mscal.connector';
import { OutlookConnector } from './outlook.connector';
import { LinkedInConnector } from './linkedin.connector';
import { SlackConnector } from './slack.connector';
import { TeamsConnector } from './teams.connector';
import { Channel, ChannelConnector } from './types';
import { WhatsAppConnector } from './whatsapp.connector';

/** Builds connectors from configuration. Connectors whose provider credentials are missing are simply not offered. */
@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<Channel, ChannelConnector>();

  constructor(@Inject(ENV) env: Env) {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      const google = () =>
        new OAuthClient({
          authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          clientId: env.GOOGLE_CLIENT_ID!,
          clientSecret: env.GOOGLE_CLIENT_SECRET!,
          // offline + consent guarantees a refresh token; incremental grants keep earlier scopes.
          extraAuthParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
        });
      this.connectors.set(
        'gmail',
        new GmailConnector(google(), { pubsubTopic: env.GOOGLE_PUBSUB_TOPIC, pubsubAudience: env.GOOGLE_PUBSUB_AUDIENCE, pubsubServiceAccount: env.GOOGLE_PUBSUB_SERVICE_ACCOUNT }),
      );
      this.connectors.set('google_calendar', new GoogleCalendarConnector(google()));
    }
    if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
      this.connectors.set('outlook', new OutlookConnector(msOAuth(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET)));
      this.connectors.set('microsoft_calendar', new MicrosoftCalendarConnector(msOAuth(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET)));
      this.connectors.set('teams', new TeamsConnector(msOAuth(env.MICROSOFT_CLIENT_ID, env.MICROSOFT_CLIENT_SECRET)));
    }
    if (env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET) {
      this.connectors.set('slack', new SlackConnector({ clientId: env.SLACK_CLIENT_ID, clientSecret: env.SLACK_CLIENT_SECRET, signingSecret: env.SLACK_SIGNING_SECRET }));
    }
    if (env.WHATSAPP_APP_ID && env.WHATSAPP_APP_SECRET && env.WHATSAPP_CONFIG_ID) {
      this.connectors.set('whatsapp', new WhatsAppConnector({ appId: env.WHATSAPP_APP_ID, appSecret: env.WHATSAPP_APP_SECRET, configId: env.WHATSAPP_CONFIG_ID, verifyToken: env.WHATSAPP_VERIFY_TOKEN, version: env.WHATSAPP_API_VERSION }));
    }
    if (env.LINKEDIN_ENABLED === 'true' && env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET) {
      this.connectors.set('linkedin', new LinkedInConnector(new OAuthClient({
        authUrl: 'https://www.linkedin.com/oauth/v2/authorization', tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
        clientId: env.LINKEDIN_CLIENT_ID, clientSecret: env.LINKEDIN_CLIENT_SECRET,
      })));
    }
  }

  get(channel: string): ChannelConnector | undefined {
    return this.connectors.get(channel as Channel);
  }

  available(): { id: Channel; displayName: string; capabilities: ChannelConnector['capabilities']; notice: string | null }[] {
    return [...this.connectors.values()].map((c) => ({ id: c.id, displayName: c.displayName, capabilities: c.capabilities, notice: c.notice ?? null }));
  }

  /** Test seam. */
  register(c: ChannelConnector): void {
    this.connectors.set(c.id, c);
  }
}
