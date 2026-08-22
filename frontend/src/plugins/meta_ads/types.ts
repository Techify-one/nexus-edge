export type AdAccount = {
  id: string;
  name: string;
  adAccountId: string;
  enabled: boolean;
  accountStatus?: number | null;
  currency?: string | null;
  timezoneName?: string | null;
  version: number;
};

export type Campaign = {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  accountId: string;
};

export type AdSet = {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  campaign_id?: string;
};

export type Ad = {
  id: string;
  name: string;
  status: string;
  effective_status: string;
  campaign_id?: string;
  adset_id?: string;
  creative?: {
    id?: string;
    thumbnail_url?: string;
    image_url?: string;
  };
};

export type Insight = {
  adId: string;
  adName: string;
  spend: number;
  clicks: number;
  impressions: number;
  purchases: number;
};
