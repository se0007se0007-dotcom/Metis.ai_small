{{- define "metis.labels" -}}
app.kubernetes.io/name: metis
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "metis.secretName" -}}
{{- if .Values.secret.existingSecret }}{{ .Values.secret.existingSecret }}{{ else }}metis-secrets{{ end -}}
{{- end -}}
{{- define "metis.image" -}}
{{ .Values.image.registry }}/metis-{{ .name }}:{{ .root.Values.image.tag }}
{{- end -}}
