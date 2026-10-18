FROM docker.elastic.co/elasticsearch/elasticsearch:8.17.0

ENV discovery.type=single-node \
    xpack.security.enabled=false \
    xpack.ml.enabled=false \
    ES_JAVA_OPTS="-Xms512m -Xmx512m"

EXPOSE 9200
