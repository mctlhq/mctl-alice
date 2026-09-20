/**
 * Types for Yandex Smart Home / IoT Cloud API (https://api.iot.yandex.net/v1.0)
 */

export interface YandexUserInfo {
  status: string;
  request_id: string;
  rooms?: YandexRoom[];
  groups?: YandexGroup[];
  devices?: YandexDevice[];
  scenarios?: YandexScenario[];
  households?: YandexHousehold[];
}

export interface YandexHousehold {
  id: string;
  name: string;
}

export interface YandexRoom {
  id: string;
  name: string;
  household_id?: string;
  devices?: string[];
}

export interface YandexGroup {
  id: string;
  name: string;
  aliases?: string[];
  household_id?: string;
  devices?: string[];
  capabilities?: YandexCapability[];
}

export interface YandexCapabilityState {
  instance: string;
  value: any;
}

export interface YandexCapability {
  type: string;
  retrievable?: boolean;
  reportable?: boolean;
  parameters?: Record<string, any>;
  state?: YandexCapabilityState;
}

export interface YandexProperty {
  type: string;
  retrievable?: boolean;
  reportable?: boolean;
  parameters?: Record<string, any>;
  state?: {
    instance: string;
    value: any;
  };
}

export interface YandexDevice {
  id: string;
  name: string;
  aliases?: string[];
  type: string;
  room?: string;
  household_id?: string;
  capabilities: YandexCapability[];
  properties?: YandexProperty[];
  item_type?: string;
  skill_id?: string;
  state?: "online" | "offline" | "split";
}

export interface YandexScenario {
  id: string;
  name: string;
  is_active: boolean;
}

export interface DeviceActionItem {
  type: string;
  state: {
    instance: string;
    value: any;
  };
}

export interface DeviceActionRequest {
  id: string;
  actions: DeviceActionItem[];
}

export interface DeviceActionResponse {
  status: "ok" | "error";
  request_id: string;
  devices?: Array<{
    id: string;
    capabilities?: Array<{
      type: string;
      state: {
        instance: string;
        action_result: {
          status: "DONE" | "ERROR";
          error_code?: string;
          error_message?: string;
        };
      };
    }>;
    action_result?: {
      status: "DONE" | "ERROR";
      error_code?: string;
      error_message?: string;
    };
  }>;
  message?: string;
  error_code?: string;
}

export interface ScenarioActionResponse {
  status: "ok" | "error";
  request_id: string;
  message?: string;
}

/**
 * Filtered speaker representation for MCP clients
 */
export interface SpeakerInfo {
  id: string;
  name: string;
  room?: string;
  type: string;
  isSpeaker: boolean;
  capabilities: string[];
}

export interface YandexDeviceDetail extends YandexDevice {
  status?: string;
  request_id?: string;
  external_id?: string;
  groups?: string[];
}

