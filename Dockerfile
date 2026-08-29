# Static site. No build stage at all: there is nothing to compile, so the image is
# nginx plus a copy, and it builds in about ten seconds.
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY img /usr/share/nginx/html/img
COPY data /usr/share/nginx/html/data
