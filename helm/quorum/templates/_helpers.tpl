{{/*
Quorum Helm Chart — template helpers
*/}}

{{/* Expand the name of the chart */}}
{{- define "quorum.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Create a default fully qualified app name */}}
{{- define "quorum.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/* Chart label */}}
{{- define "quorum.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Common labels */}}
{{- define "quorum.labels" -}}
helm.sh/chart: {{ include "quorum.chart" . }}
{{ include "quorum.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels */}}
{{- define "quorum.selectorLabels" -}}
app.kubernetes.io/name: {{ include "quorum.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* ── Gateway helpers ─────────────────────────────────────────── */}}

{{- define "quorum.gateway.fullname" -}}
{{- printf "%s-gateway" (include "quorum.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quorum.gateway.labels" -}}
{{ include "quorum.labels" . }}
app.kubernetes.io/component: gateway
{{- end }}

{{- define "quorum.gateway.selectorLabels" -}}
{{ include "quorum.selectorLabels" . }}
app.kubernetes.io/component: gateway
{{- end }}

{{/* Gateway JWT secret name */}}
{{- define "quorum.gateway.jwtSecretName" -}}
{{- if .Values.gateway.jwtSecret.existingSecret }}
{{- .Values.gateway.jwtSecret.existingSecret }}
{{- else }}
{{- printf "%s-jwt-keys" (include "quorum.gateway.fullname" .) }}
{{- end }}
{{- end }}

{{/* ── PostgreSQL helpers ──────────────────────────────────────── */}}

{{- define "quorum.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "quorum.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quorum.postgresql.labels" -}}
{{ include "quorum.labels" . }}
app.kubernetes.io/component: postgresql
{{- end }}

{{- define "quorum.postgresql.selectorLabels" -}}
{{ include "quorum.selectorLabels" . }}
app.kubernetes.io/component: postgresql
{{- end }}

{{/* PostgreSQL password secret name */}}
{{- define "quorum.postgresql.secretName" -}}
{{- if .Values.postgresql.existingSecret }}
{{- .Values.postgresql.existingSecret }}
{{- else }}
{{- printf "%s-postgresql" (include "quorum.fullname" .) }}
{{- end }}
{{- end }}

{{/* ── FalkorDB helpers ────────────────────────────────────────── */}}

{{- define "quorum.falkordb.fullname" -}}
{{- printf "%s-falkordb" (include "quorum.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quorum.falkordb.labels" -}}
{{ include "quorum.labels" . }}
app.kubernetes.io/component: falkordb
{{- end }}

{{- define "quorum.falkordb.selectorLabels" -}}
{{ include "quorum.selectorLabels" . }}
app.kubernetes.io/component: falkordb
{{- end }}

{{/* ── Graphiti helpers ────────────────────────────────────────── */}}

{{- define "quorum.graphiti.fullname" -}}
{{- printf "%s-graphiti" (include "quorum.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "quorum.graphiti.labels" -}}
{{ include "quorum.labels" . }}
app.kubernetes.io/component: graphiti
{{- end }}

{{- define "quorum.graphiti.selectorLabels" -}}
{{ include "quorum.selectorLabels" . }}
app.kubernetes.io/component: graphiti
{{- end }}

{{/* Graphiti OpenAI secret name */}}
{{- define "quorum.graphiti.openaiSecretName" -}}
{{- if .Values.graphiti.openaiSecret.existingSecret }}
{{- .Values.graphiti.openaiSecret.existingSecret }}
{{- else }}
{{- printf "%s-graphiti-openai" (include "quorum.fullname" .) }}
{{- end }}
{{- end }}
