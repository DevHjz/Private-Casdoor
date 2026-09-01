// Copyright 2026 The Casdoor Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as React from "react";
import i18next from "i18next";
import {Avatar, AvatarFallback, AvatarImage} from "@/components/ui/avatar";
import {Button} from "@/components/ui/button";
import {Alert, AlertDescription} from "@/components/ui/alert";
import * as Setting from "@/lib/setting";
import * as Util from "@/auth/Util";

const nativeSsoCandidatePorts = [47321, 47322, 47323, 47324, 47325];
const nativeSsoStatusPath = "/native-sso/status";
const nativeSsoAuthorizePath = "/native-sso/authorize";

interface NativeSsoAgent {
  port: number;
  available: boolean;
  serverUrl: string;
  applicationName?: string;
  displayName?: string;
  userName?: string;
  username?: string;
  name?: string;
  avatar?: string;
}

interface NativeSsoPanelProps {
  application: any;
  type?: string;
  initialAgent?: NativeSsoAgent;
  restartKey?: number;
  onActiveChange?: (active: boolean) => void;
  onSuccess?: (result: any) => void;
  onFallback?: (message: string, agent: NativeSsoAgent | null) => void;
}

export function NativeSsoPanel({
  application,
  type = "login",
  initialAgent,
  restartKey = 0,
  onActiveChange,
  onSuccess,
  onFallback,
}: NativeSsoPanelProps) {
  const [agent, setAgent] = React.useState<NativeSsoAgent | null>(initialAgent || null);
  const [active, setActive] = React.useState(!!initialAgent);
  const [authorizing, setAuthorizing] = React.useState(false);
  const [error, setError] = React.useState("");
  const disposedRef = React.useRef(false);

  const updateActive = (newActive: boolean) => {
    setActive(newActive);
    onActiveChange?.(newActive);
  };

  const getNativeSsoBaseUrl = (port: number) => `http://127.0.0.1:${port}`;

  const fetchNativeSsoJson = async (url: string, options: any = {}) => {
    const timeoutMs = options.timeoutMs ?? 1200;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      ...(options.headers || {}),
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers,
      });
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  };

  const getNativeSsoRequestContext = () => {
    const oAuthParams = Util.getOAuthGetParameters();
    const responseType = oAuthParams?.responseType || (oAuthParams?.samlRequest ? "saml" : type);
    return {
      serverUrl: Setting.getFullServerUrl(),
      clientId: application?.clientId || oAuthParams?.clientId || "",
      applicationName: application?.name || "",
      organization: application?.organization || "",
      responseType: responseType,
      redirectUri: oAuthParams?.redirectUri || "",
      scope: oAuthParams?.scope || "openid profile email device_sso",
      state: oAuthParams?.state || "",
      nonce: oAuthParams?.nonce || "",
      codeChallenge: oAuthParams?.codeChallenge || "",
      challengeMethod: oAuthParams?.challengeMethod || "",
      resource: oAuthParams?.resource || "",
    };
  };

  const isNativeSsoStatusValid = (status: any) => {
    return status?.available === true &&
      String(status.serverUrl || "").replace(/\/+$/, "") === Setting.getFullServerUrl().replace(/\/+$/, "");
  };

  const startDiscovery = React.useCallback(async () => {
    if (!application?.clientId) {
      updateActive(false);
      return;
    }

    setAuthorizing(false);
    setError("");

    const candidatePorts = initialAgent?.port
      ? [initialAgent.port, ...nativeSsoCandidatePorts.filter(p => p !== initialAgent.port)]
      : nativeSsoCandidatePorts;

    if (initialAgent?.port) {
      setAgent(initialAgent);
      updateActive(true);
    }

    const discover = async () => {
      for (const port of candidatePorts) {
        try {
          const query = new URLSearchParams({
            serverUrl: Setting.getFullServerUrl(),
            clientId: application.clientId,
          });
          const status = await fetchNativeSsoJson(`${getNativeSsoBaseUrl(port)}${nativeSsoStatusPath}?${query.toString()}`);
          
          if (disposedRef.current) return true;

          if (isNativeSsoStatusValid(status)) {
            const newAgent = {
              ...initialAgent,
              ...status,
              port: port,
            };
            setAgent(newAgent);
            setError("");
            updateActive(true);
            return true;
          }
        } catch (e) {
          // Continue to next port
        }
      }
      return false;
    };

    const found = await discover();
    if (!found && !disposedRef.current) {
      // If not found, try once more after a short delay to handle agent startup
      setTimeout(async () => {
        if (!disposedRef.current) {
          const foundSecond = await discover();
          if (!foundSecond && !disposedRef.current && !initialAgent) {
            setAgent(null);
            updateActive(false);
          }
        }
      }, 3000);
    }
  }, [application?.clientId, initialAgent, restartKey]);

  React.useEffect(() => {
    disposedRef.current = false;
    startDiscovery();
    return () => {
      disposedRef.current = true;
    };
  }, [startDiscovery]);

  const authorize = async () => {
    if (!agent?.port || authorizing) return;

    setAuthorizing(true);
    setError("");
    try {
      const result = await fetchNativeSsoJson(`${getNativeSsoBaseUrl(agent.port)}${nativeSsoAuthorizePath}`, {
        method: "POST",
        body: JSON.stringify(getNativeSsoRequestContext()),
        timeoutMs: 120000,
      });

      if (result?.status !== "approved") {
        onFallback?.(result?.message || result?.msg || i18next.t("login:Native SSO was denied"), agent);
        return;
      }

      onSuccess?.(result);
    } catch (err: any) {
      onFallback?.(err.message || i18next.t("login:Native SSO was denied"), agent);
    }
  };

  if (!active || !agent) return null;

  const appDisplayName = agent.applicationName || application?.displayName || application?.name || "";
  const agentName = agent.displayName || agent.userName || agent.username || agent.name || "";
  const agentAvatar = agent.avatar || "";

  return (
    <div className="mx-auto flex max-w-xs flex-col items-center gap-4 text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{i18next.t("login:Native SSO")}</h2>
        <p className="text-sm text-muted-foreground">
          {i18next.t("login:Signed in on this device with {app}").replace("{app}", appDisplayName)}
        </p>
      </div>

      <div className="w-full rounded-lg border bg-muted/30 p-6 space-y-4">
        <div className="flex flex-col items-center gap-3">
          <Avatar className="h-20 w-20 border-2 border-background shadow-sm">
            {agentAvatar ? (
              <AvatarImage src={agentAvatar} alt={agentName} />
            ) : null}
            <AvatarFallback className="text-xl" style={{backgroundColor: Setting.getAvatarColor(agentName)}}>
              {agentName ? agentName.substring(0, 1).toUpperCase() : "?"}
            </AvatarFallback>
          </Avatar>
          {agentName && <div className="text-lg font-bold">{agentName}</div>}
          <div className="text-sm text-primary font-medium">
            {i18next.t("login:Native SSO is ready")}
          </div>
        </div>

        <div className="space-y-2">
          <Button className="w-full h-11" onClick={authorize} disabled={authorizing}>
            {i18next.t("login:Native SSO")}
          </Button>
          <Button variant="link" className="text-sm text-muted-foreground" onClick={() => onFallback?.("", agent)}>
            {i18next.t("login:Use other login methods")}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
