from django.urls import include, path
from django.conf import settings
from django.contrib import admin
from django.views.decorators.csrf import csrf_exempt
from django.views.i18n import set_language


admin.autodiscover()

urlpatterns = [
    path('choose-language', csrf_exempt(set_language), name='set_language'),
    path('login/', include('sa_login.urls')),
    path('admin/', include('sa_admin.urls')),
    path('', include('sa_web.urls')),
]

if settings.SHAREABOUTS['DATASET_ROOT'].startswith('/'):
    urlpatterns = [
        path('full-api/', include('sa_api_v2.urls')),
    ] + urlpatterns
