# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class ru.agrocontrol.driver.**$$serializer { *; }
-keepclassmembers class ru.agrocontrol.driver.** { *** Companion; }
-keepclasseswithmembers class ru.agrocontrol.driver.** { kotlinx.serialization.KSerializer serializer(...); }
# Retrofit
-keepattributes Signature, Exceptions
-keep,allowobfuscation,allowshrinking interface retrofit2.Call
-keep,allowobfuscation,allowshrinking class kotlin.coroutines.Continuation
